/**
 * Home, the screen that isn't the Market (scratch/global-node/DESIGN-home-dashboard-fable.md, slices H0 and H0b): the
 * whole screen as one answer, assembled in-process from the reads each card's own screen already makes, for GET
 * /api/home (routes/home.ts).
 *
 * ## The cards
 *
 * HOME_CARD_IDS is the catalogue (§3.1), in the default order. A card with nothing to say is left out of the answer
 * rather than sent empty ("cards with nothing to say take no space"), so the shown-when rules that need the node's data
 * are applied here; the ones that need only the member's own layout (a dismissal, a hidden card) are the app's. Two
 * cards carry no data of their own: `interests` is drawn from `me.interests`, and `invite` from `features.invites` and
 * `me.firstOffer` (§3.1 "after the first Offer"). `me.firstOffer` is in every answer to a reader with their own cards,
 * whatever the layout hides: `steps` can be hidden, and a hidden card isn't built, so its own `firstOffer` can't decide it.
 *
 * ## Who gets what
 *
 * Nothing here is anything the reader couldn't already read from the card's own screen, and each card is computed for
 * the verified signer only (never a key from the query):
 *   - the reader's OWN cards (`needs`, `safety`, `steps`, `deals`, `enterprise`, `groups`, `beans`, `notices`, and `me`
 *     and `layout`): for a key that passes the read gate (passesReadGate: a member, a suspended one included, as for
 *     their own messages, trades and Beans). Each is about the signer and nobody else: no other member's balance, deal,
 *     notice or vote is ever read for it (privacy-defaults-2026-09-28).
 *   - the COMMUNITY's cards, what other members post and do (`events`, `market`, `decide`, `joined`, `pulse`): for a
 *     reader who reads as a member (readsAsMember). A suspended or disabled member, while that lasts, and everyone else
 *     get the visitors' subset where the node has one, and nothing of these elsewhere. Such a member's `me` says so
 *     (`standing: 'suspended'`), and they never get `welcome`: that is the visitors' Join card (§3.2 (c), §5.3), and
 *     a suspended member invited to join would be invited to open a second account while the first is suspended.
 *   - the visitors' subset (§5.3), on a node that shows visitors the listings and not the people (`guestListingsOnly`, the
 *     global profile): `find`, `market` and `events` in the listings' visitors' view (guestPost: nobody in them, each place
 *     its rough area), and `community` (counts). No Pulse, no `joined`, nothing of the reader's own unless they pass the
 *     gate, and `welcome: true` for a reader with no account here (no `me`).
 *   - `community`: anyone who is answered at all. Its counts are community totals, public by rule.
 *
 * ## Money (H0b)
 *
 * `beans` is the signer's own balance and nothing else (getBalance(signer)), only where the `beans` switch is on; `deals`
 * and the needs line for a deal are the signer's own marketplace trades, only where `escrow` is on. Neither is read for
 * anyone the signer names.
 *
 * ## Cost
 *
 * `cards=` limits the work: only the cards asked for are computed (a hidden Pulse runs no Pulse query), and each read has
 * a limit. `homeCardBuilds` counts each card's assembly, for the suite to prove it. "Coming up" reads the soonest few
 * events in start order (PostFilter.upcomingUntil, on idx_posts_event_start), never every event on the node.
 *
 * ## Size
 *
 * Every text a member, a feed or a peer sets is cut or left out (`clip`, `bounded`), the category and the Pulse link
 * included, so the answer stays a few kilobytes whatever anyone typed (§5.2 "under 6 KB gzipped").
 */
import { PRICING_CATEGORIES, avatarUrlOf, normalizeCategory } from '@beanpool/core';
import { ONE_PASS_MAX_MEASURED, guestPost, haversineKm, type MarketplacePost } from '@beanpool/engine';
import { db } from '../db/db.js';
import {
    getMember, getPosts, getBalance, getMarketplaceTransactions, getConversationsByMember, getListedUnreadCounts,
    listYourChats, keeperOf, isVisitorKey, readsAsMember, passesReadGate, getPublicCommunityInfo,
} from '../state-engine.js';
import { getNodeProfile, getNodeFeatures, getProfileSwitches, type NodeFeatures, type NodeProfile, type ProfileSwitches } from '../config/node-profile.js';
import { getDoor, type Door } from '../config/door.js';
import { getLocalConfig } from '../config/local-config.js';
import { nodeRoleOf } from '../engine/node-roles.js';
import { getAdminQueue, type AdminQueueItem, type AdminSettingsSection } from '../engine/admin-queue.js';
import { listKeptNotices } from '../engine/kept-notices.js';
import { probationRuleSet, probationSummary, type ProbationSummary } from '../engine/probation.js';
import { readMemberArea } from '../engine/member-area.js';
import { chatHiddenFrom } from '../engine/event-thread.js';
import { getPulseFeed } from '../engine/pulse-resolver.js';
import { listedCommunityCount } from '../engine/directory-cache.js';
import { decisionsOn, madeWithoutVote, getOpenDecisions, getOwnDecisionVotes, hasCompletedTrade, getVoiceCredits } from '../decisions-engine.js';
import { landingCardFor, type LandingCard } from './global-directory.js';

/** The catalogue (§3.1), in the default order (§3.1 "Default order"). */
export const HOME_CARD_IDS = [
    'needs', 'safety', 'find', 'steps', 'interests', 'deals', 'enterprise', 'events', 'market', 'decide', 'groups', 'joined',
    'pulse', 'beans', 'notices', 'invite', 'community',
] as const;
export type HomeCardId = typeof HOME_CARD_IDS[number];
const CARD_IDS: ReadonlySet<string> = new Set(HOME_CARD_IDS);
export const isHomeCardId = (id: unknown): id is HomeCardId => typeof id === 'string' && CARD_IDS.has(id);

/** Cards a member can't hide (§4.1): `needs` costs them something if missed, `community` holds "Edit home". `find` too, for its first 30 days on the global node. */
const UNHIDEABLE: ReadonlySet<HomeCardId> = new Set(['needs', 'community']);
const FIND_PINNED_DAYS = 30;

/** The cards a visitor's Home is made of (§5.3). */
export const VISITOR_CARDS: ReadonlySet<HomeCardId> = new Set(['find', 'market', 'events', 'community']);

/** Each card's assembly, counted: the suite proves `cards=` skips the work of a card not asked for. */
export const homeCardBuilds: Record<string, number> = {};
const built = (id: HomeCardId) => { homeCardBuilds[id] = (homeCardBuilds[id] ?? 0) + 1; };

const DAY_MS = 86_400_000;
/** How far back the Market and Pulse cards look (§3.1), and how far ahead "Coming up". */
const MARKET_DAYS = 14;
const EVENT_DAYS = 14;
const JOINED_DAYS = 7;
const PULSE_DAYS = 7;
const STEPS_DAYS = 14;
/** How many of each a card shows (§3.1, §5.1). */
const MARKET_ITEMS = 4;
const VISITOR_MARKET_ITEMS = 3;
const EVENT_ITEMS = 3;
const GROUP_ITEMS = 3;
const JOINED_NAMES = 4;
const PULSE_ITEMS = 2;
/** The newest listings the Market card chooses its few from (starred categories first), and counts in `total14d`. */
const MARKET_POOL = 40;
/**
 * The soonest events "Coming up" reads, in start order (PostFilter.upcomingUntil): the few it shows and two spare, for
 * one whose times can't be read (a peer's copy) and is left out here.
 */
const EVENT_POOL = EVENT_ITEMS + 2;
/** Open polls counted, then "50+". */
const POLL_POOL = 50;
/** Fewer real listings in view than this, on a node that asks for them, and the app shows its example cards (utils/example-listings.ts). */
const EXAMPLES_BELOW = 6;
/** "14 people within 50 km joined this week" (global, §3.1). */
const JOINED_RADIUS_KM = 50;
/** "Coming up · within 50 km" on a node whose listings come nearest first (global). */
const EVENTS_RADIUS_KM = 50;
/** A layout names at most this many ids, an interests list at most every category (§4.2, §4.3). */
const LAYOUT_MAX_IDS = 32;
const CATEGORY_IDS: ReadonlySet<string> = new Set(PRICING_CATEGORIES.map(c => c.id));

export const HOME_LAYOUT_PREF_KEY = 'home.layout';
export const HOME_INTERESTS_PREF_KEY = 'interests';

// ── what the answer holds ────────────────────────────────────────────────────────────────────────────────────────────

export type NeedsKind = 'admin' | 'deal' | 'vote' | 'message' | 'group';
/** Where a tap lands: the same targets the header's "needs you" icons use (apps/native utils/needs-you.ts). */
export type NeedsTarget =
    | { to: 'admin'; section: AdminSettingsSection }
    | { to: 'deal'; postId: string; txId: string }
    | { to: 'my-deals' }
    | { to: 'decide' }
    | { to: 'chat'; conversationId: string; event?: boolean; thread?: 'group' | 'enterprise' }
    | { to: 'unread-messages' }
    | { to: 'your-groups' };
/** One line of "Needs you", the shape apps/native utils/needs-you.ts builds. `closesAt` on a vote, so an app words it in the member's own time. */
export interface NeedsItem { kind: NeedsKind; count: number; accent: boolean; label: string; target: NeedsTarget; closesAt?: string }

export interface HomeLayout { v: 1; order: HomeCardId[]; hidden: HomeCardId[]; dismissed: { safety?: string }; updatedAt: string | null }

export interface HomeMe {
    joinedAt: string | null;
    isKeeper: boolean;
    /** Their own new-account limits while they last (engine/probation.ts), else null. */
    probation: ProbationSummary | null;
    interests: string[];
    area: { lat: number; lng: number } | null;
    /**
     * Whether they have posted an Offer here, which decides the `invite` card (§3.1 "after the first Offer"), whatever
     * their layout hides (the `steps` card, which also says it, can be hidden and is then not built).
     */
    firstOffer: boolean;
    /**
     * 'member', or 'suspended' while their account is suspended or disabled: they read their own things and see the
     * community as a visitor does (readsAsMember), and an app says so in plain words rather than inviting them to join.
     */
    standing: 'member' | 'suspended';
}

export interface MarketItem { id: string; type: 'offer' | 'need'; title: string; category: string; credits?: number; photoUrl: string | null; distanceKm?: number | null }
export interface EventItem { id: string; title: string; startsAt: string; endsAt: string | null; place: string | null; rsvp: 'going' | 'interested' | null; distanceKm?: number | null }

export interface HomeCards {
    needs?: { items: NeedsItem[] };
    safety?: { words: true; signInLinked: false };
    find?: LandingCard;
    steps?: { joinedAt: string | null; firstOffer: boolean; firstPost: boolean; photo: boolean; interests: boolean; invited: boolean | null; area: boolean; knocked: null };
    deals?: { open: number; waiting: number; waitingOnMe: { txId: string; postId: string; title: string } | null };
    enterprise?: { id: string; name: string; requests: number; others: number };
    events?: { items: EventItem[]; radiusKm: number | null };
    market?: { items: MarketItem[]; total14d: number; more: boolean; examples?: true };
    decide?: { open: number; soonestClosesAt: string | null; polls: number; pollsMore: boolean };
    groups?: { items: { id: string; kind: 'group' | 'enterprise' | 'event'; name: string; unread: number; muted: boolean }[]; total: number };
    joined?: { count7d: number; radiusKm: number | null; names?: { callsign: string; avatarUrl: string | null }[] };
    pulse?: { items: { id: string; title: string | null; thumbnailUrl: string | null; platform: string; callsign: string; category: string; url: string | null }[] };
    beans?: { balance: number; room: number; tier: string; activated: boolean; frozen: boolean };
    notices?: { unseen: number; first: { id: string; title: string; line: string } };
    community?: { name: string | null; members: number; tradesThisMonth?: number; communities?: number };
}

export interface HomeAnswer {
    generatedAt: string;
    profile: NodeProfile;
    features: NodeFeatures & { door: Door };
    /** The visitors' Home (§5.3): a reader who doesn't read as a member, on a node that shows them the listings. */
    welcome?: true;
    me: HomeMe | null;
    layout: HomeLayout | null;
    cards: HomeCards;
}

// ── the reader ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface HomeReader {
    /** The verified signer (ctx.state.actor), or undefined for an unsigned read. Never a key from the request. */
    actor: string | undefined;
    /** A point the request gave (lat, lng), parsed. */
    point: { lat: number; lng: number } | null;
    /** `cards=` as asked, unknown ids dropped; undefined when not given (the default list). */
    asked: HomeCardId[] | undefined;
    now?: number;
}

interface Ctx {
    me: string | null;
    /** passesReadGate: the reader's own cards. */
    own: boolean;
    /** readsAsMember: the community's cards. */
    member: boolean;
    /** Neither a member's read nor nothing: the visitors' subset (§5.3). */
    guestView: boolean;
    point: { lat: number; lng: number } | null;
    /** The point the request itself gave, for the landing card, which falls back to the area itself and says so. */
    askedPoint: { lat: number; lng: number } | null;
    now: number;
    switches: ProfileSwitches;
    features: NodeFeatures;
    interests: string[];
    /** Read once per answer, for `needs` and `groups`. */
    chats?: ReturnType<typeof listYourChats>;
    /** Read once per answer, for `steps` and `me`. */
    firstOffer?: boolean;
}

/**
 * Whether this reader is answered at all, and how. On a node with the visitors' view anyone is (the visitors' subset at
 * least). Elsewhere only a key that passes the read gate is: the route answers anyone else 401/403, whatever
 * ENFORCE_READ_AUTH says.
 */
export function homeReaderStanding(actor: string | undefined): 'own' | 'guest' | 'refused' {
    if (actor && passesReadGate(actor)) return 'own';
    return getProfileSwitches().guestListingsOnly ? 'guest' : 'refused';
}

// ── the stored layout and interests (the H1 preference keys) ─────────────────────────────────────────────────────────

function readPref(me: string, key: string): unknown {
    const row = db.prepare('SELECT pref_value FROM member_preferences WHERE public_key = ? AND pref_key = ?').get(me, key) as { pref_value: string } | undefined;
    if (!row) return undefined;
    try { return JSON.parse(row.pref_value); } catch { return undefined; }
}

/** Unknown ids dropped, never refused (§4.1: a node older or newer than the app); each id once; at most LAYOUT_MAX_IDS. */
function cardIds(raw: unknown): HomeCardId[] {
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.filter(isHomeCardId))].slice(0, LAYOUT_MAX_IDS);
}

const isIso = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));

/** The member's `home.layout` (§4.2), as stored by the preferences route, read defensively: anything malformed is no layout. */
export function readHomeLayout(me: string): HomeLayout | null {
    const raw = readPref(me, HOME_LAYOUT_PREF_KEY) as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const dismissed = raw.dismissed && typeof raw.dismissed === 'object' ? raw.dismissed as Record<string, unknown> : {};
    return {
        v: 1,
        order: cardIds(raw.order),
        hidden: cardIds(raw.hidden),
        dismissed: isIso(dismissed.safety) ? { safety: dismissed.safety } : {},
        updatedAt: isIso(raw.updatedAt) ? raw.updatedAt : null,
    };
}

/** The member's starred categories (§4.3): known category ids only, each once. */
export function readInterests(me: string): string[] {
    const raw = readPref(me, HOME_INTERESTS_PREF_KEY);
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.filter((c): c is string => typeof c === 'string' && CATEGORY_IDS.has(c)))];
}

// ── shared helpers ───────────────────────────────────────────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * A card shows a line or two of each text (§9: `numberOfLines`, the full text one tap away), and a listing's title has no
 * length cap (engine/post-fields.ts), so each text is cut here: the answer stays a few kilobytes whatever anyone typed.
 */
const TITLE_CHARS = 120;
const NAME_CHARS = 60;
/** A category: one of the catalogue's ids, or a short word an older app or a peer stored. Only checked to be text (engine/post-fields.ts). */
const CATEGORY_CHARS = 40;
/** A link out (a Pulse item's): longer is no link a card can use, so it is left out, never cut (pulse-submit MAX_ITEM_URL_LENGTH). */
const URL_CHARS = 2048;
/** An id or a short machine word (a platform, a time): the node's own are far shorter; a longer one is a peer's or a feed's, and left out. */
const ID_CHARS = 128;
function clip(s: string, max: number): string {
    const chars = Array.from(s);
    return chars.length <= max ? s : `${chars.slice(0, max - 1).join('')}…`;
}
/** Text that can't be cut without breaking it (an id, a link, a time): itself while it is at most `max` long, else null. */
function bounded(s: string | null | undefined, max: number): string | null {
    return typeof s === 'string' && s.length <= max ? s : null;
}
const round2 = (n: number) => Math.round(n * 100) / 100;
const iso = (ms: number) => new Date(ms).toISOString();

/** Starred categories first, the rest after, each part in the order it came: interests reorder, they never filter (§4.3). */
function starredFirst<T>(items: T[], categoryOf: (t: T) => string, interests: string[]): T[] {
    if (!interests.length) return items;
    const starred = new Set(interests);
    const isStarred = (t: T) => starred.has(normalizeCategory(categoryOf(t)));
    return [...items.filter(isStarred), ...items.filter(t => !isStarred(t))];
}

/** A vote's closing in words, from hours and days only: the server can't know the member's time of day ("tonight"). */
function closesInWords(closesAt: string, now: number): string {
    const ms = Date.parse(closesAt) - now;
    const hours = Math.floor(ms / 3600_000);
    if (hours < 1) return 'closes within the hour';
    if (hours < 48) return `closes in ${plural(hours, 'hour', 'hours')}`;
    return `closes in ${Math.floor(hours / 24)} days`;
}
const VOTE_ACCENT_WINDOW_MS = 48 * 3600_000;

/** One admin-queue item in words, as the header says it (apps/native utils/needs-you.ts adminItemInWords). */
function adminItemInWords(i: Pick<AdminQueueItem, 'kind' | 'count' | 'label'>, decisions: boolean): string {
    const n = i.count;
    switch (i.kind) {
        case 'reports': return `${plural(n, 'report', 'reports')} to review`;
        case 'disputes': return `${plural(n, 'stalled trade', 'stalled trades')} awaiting a ruling`;
        case 'suspensions': return !decisions
            ? (n === 1 ? '1 emergency suspension in its 7 days' : `${n} emergency suspensions in their 7 days`)
            : `${plural(n, 'emergency suspension', 'emergency suspensions')} the community is voting on`;
        case 'removals': return n === 1 ? '1 removal in its 7-day grace period' : `${n} removals in their 7-day grace period`;
        case 'unclean_shutdown': return 'the node restarted after an unclean shutdown';
        default: return `${i.label.charAt(0).toLowerCase()}${i.label.slice(1)}: ${n}`;
    }
}

function chats(c: Ctx): ReturnType<typeof listYourChats> {
    return c.chats ??= listYourChats(c.me!);
}

const muted = (mute: { mutedUntil: string | null; always?: boolean } | null | undefined, now: number) =>
    !!mute && (!!mute.always || mute.mutedUntil === null || Date.parse(mute.mutedUntil) > now);

/** The signer's open marketplace trades (requested or in progress), newest first: the deals card's and the needs line's. */
function openDeals(me: string) {
    return [...getMarketplaceTransactions(me, { status: 'requested' }, 200), ...getMarketplaceTransactions(me, { status: 'pending' }, 200)]
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

/** A step that is the member's to take: accept a request made to them, or finish a deal in progress (needs-you.ts dealsWaiting). */
const waitsOn = (t: { status: string; buyerPublicKey: string; sellerPublicKey: string }, me: string) =>
    (t.status === 'requested' && t.sellerPublicKey === me) || (t.status === 'pending' && (t.buyerPublicKey === me || t.sellerPublicKey === me));

// ── the cards ────────────────────────────────────────────────────────────────────────────────────────────────────────

function needsCard(c: Ctx): HomeCards['needs'] | undefined {
    built('needs');
    const me = c.me!;
    const items: NeedsItem[] = [];

    // Owners, admins and moderators only, as GET /api/node-admin/queue answers it: an active member's row that isn't a
    // visitor's, holding a node role. A moderator's queue is the reports alone.
    const role = nodeRoleOf(me);
    const row = getMember(me);
    if (role && row?.status === 'active' && !isVisitorKey(me)) {
        const queue = getAdminQueue({ forModerator: role === 'moderator', forOwner: role === 'owner' });
        const work = queue.items.filter(i => i.count > 0);
        if (queue.total > 0 && work.length) {
            const parts = work.map(i => adminItemInWords(i, c.switches.decisions));
            const joined = parts.length <= 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
            items.push({ kind: 'admin', count: queue.total, accent: true, label: joined.charAt(0).toUpperCase() + joined.slice(1), target: { to: 'admin', section: work[0].section } });
        }
    }

    // H0b: the signer's own trades, where escrow is on.
    if (c.switches.escrow) {
        const deals = openDeals(me).filter(t => waitsOn(t, me));
        if (deals.length) {
            const [first] = deals;
            items.push({
                kind: 'deal', count: deals.length, accent: true,
                label: deals.length === 1 ? `A deal is waiting for you: ${clip(first.postTitle, TITLE_CHARS)}` : `${deals.length} deals waiting for you`,
                target: deals.length === 1 && first.postId ? { to: 'deal', postId: first.postId, txId: first.id } : { to: 'my-deals' },
            });
        }
    }

    // Votes the member hasn't cast on Decisions open now, as the signed decisions list gives them (routes/commons.ts):
    // formal Decisions only where they are on, never an emergency suspension made while they were off, and never a money
    // vote the member can't cast yet (no completed trade and no voice credits), which isn't asking anything of them. Only
    // for a reader who reads as a member: a suspended member casts no vote, and the line names the Decision.
    if (c.member && decisionsOn()) {
        const mine = getOwnDecisionVotes(me);
        const blocked = !hasCompletedTrade(me) && getVoiceCredits(me) <= 0;
        const votes = getOpenDecisions()
            .filter(d => !madeWithoutVote(d) && !mine.has(d.id)
                && Date.parse(d.opensAt) <= c.now && Date.parse(d.closesAt) > c.now
                && !(d.franchise === 'quadratic_trade' && blocked))
            .sort((a, b) => Date.parse(a.closesAt) - Date.parse(b.closesAt));
        if (votes.length) {
            const soonest = votes[0].closesAt;
            const when = closesInWords(soonest, c.now);
            items.push({
                kind: 'vote', count: votes.length, accent: Date.parse(soonest) - c.now <= VOTE_ACCENT_WINDOW_MS,
                label: votes.length === 1 ? `Vote ${when}: ${clip(votes[0].title, TITLE_CHARS)}` : `${votes.length} votes to cast, the first ${when}`,
                target: { to: 'decide' }, closesAt: soonest,
            });
        }
    }

    // Unread from people: direct conversations only, over the chats the member's list shows (getListedUnreadCounts), as
    // GET /api/messages/conversations/:publicKey counts them. Group, event and enterprise chats are the next line.
    const unread = getListedUnreadCounts(me);
    const dms = getConversationsByMember(me)
        .filter(conv => conv.type === 'dm' && (unread[conv.id] ?? 0) > 0 && !chatHiddenFrom(conv, me))
        .map(conv => ({ id: conv.id, unread: unread[conv.id], peer: clip(conv.peerCallsign || 'Someone', NAME_CHARS) }));
    if (dms.length) {
        const total = dms.reduce((n, d) => n + d.unread, 0);
        items.push({
            kind: 'message', count: dms.length, accent: false,
            label: dms.length === 1
                ? (dms[0].unread === 1 ? `Unread message from ${dms[0].peer}` : `${dms[0].unread} unread messages from ${dms[0].peer}`)
                : `${total} unread from ${dms.length} people`,
            target: dms.length === 1 ? { to: 'chat', conversationId: dms[0].id } : { to: 'unread-messages' },
        });
    }

    // New lines in their groups, enterprises and events, muted ones left quiet (GET /api/your-groups).
    const groups = chats(c).items.filter(g => g.unreadCount > 0 && !muted(g.mute, c.now));
    if (groups.length) {
        const [g] = groups;
        items.push({
            kind: 'group', count: groups.length, accent: false,
            label: groups.length === 1 ? `${plural(g.unreadCount, 'new line', 'new lines')} in ${clip(g.name, NAME_CHARS)}` : `New lines in ${groups.length} of your groups`,
            target: groups.length === 1
                ? (g.kind === 'event' ? { to: 'chat', conversationId: g.conversationId, event: true } : { to: 'chat', conversationId: g.conversationId, thread: g.kind as 'group' | 'enterprise' })
                : { to: 'your-groups' },
        });
    }
    return items.length ? { items } : undefined;
}

/** A member who came in by 12 words and has added no sign-in: their words are the only way back (two-doors §2.5). */
function safetyCard(c: Ctx): HomeCards['safety'] | undefined {
    built('safety');
    return probationRuleSet(c.me!) === 'words' ? { words: true, signInLinked: false } : undefined;
}

function findCard(c: Ctx): HomeCards['find'] | undefined {
    built('find');
    // The landing card exists where the directory does (the global profile's `directoryMirror`), as /api/global/home does.
    if (!c.switches.directoryMirror) return undefined;
    return landingCardFor(c.me ?? undefined, c.askedPoint, !c.member);
}

/** Whether the signer has posted an Offer here (any status: a first Offer since taken down still counts), read once per answer. */
function firstOfferOf(c: Ctx): boolean {
    return c.firstOffer ??= !!(db.prepare("SELECT EXISTS(SELECT 1 FROM posts WHERE author_pubkey = ? AND type = 'offer' AND origin_node IS NULL) AS offer")
        .get(c.me!) as { offer: number }).offer;
}

function stepsCard(c: Ctx): HomeCards['steps'] | undefined {
    built('steps');
    const me = c.me!;
    const row = getMember(me);
    const mine = db.prepare(`SELECT
            EXISTS(SELECT 1 FROM posts WHERE author_pubkey = ? AND type IN ('offer', 'need') AND origin_node IS NULL) AS post,
            EXISTS(SELECT 1 FROM invite_codes WHERE created_by = ?) AS invited`).get(me, me) as { post: number; invited: number };
    const steps = {
        joinedAt: row?.joinedAt ?? null,
        firstOffer: firstOfferOf(c),
        firstPost: !!mine.post,
        photo: !!row?.avatarUrl,
        interests: c.interests.length > 0,
        // Where invites are off (the global node) there is no such step.
        invited: c.switches.invites ? !!mine.invited : null,
        area: !!readMemberArea(me),
        // A knock is kept on the community knocked on (G6), not here: the app reads its status there.
        knocked: null,
    };
    const joinedMs = steps.joinedAt ? Date.parse(steps.joinedAt) : NaN;
    const young = Number.isFinite(joinedMs) && c.now - joinedMs < STEPS_DAYS * DAY_MS;
    // The lines a member sees (§3.1): local — first Offer, a photo, interests, an invite (once they have an Offer);
    // global — their area and a first post.
    const undone = c.switches.guestListingsOnly
        ? !steps.area || !steps.firstPost
        : !steps.firstOffer || !steps.photo || !steps.interests || (steps.invited === false && steps.firstOffer);
    return young || undone ? steps : undefined;
}

/** H0b: the signer's own open trades, where escrow is on. */
function dealsCard(c: Ctx): HomeCards['deals'] | undefined {
    built('deals');
    if (!c.switches.escrow) return undefined;
    const me = c.me!;
    const open = openDeals(me);
    if (!open.length) return undefined;
    const waiting = open.filter(t => waitsOn(t, me));
    const first = waiting[0];
    return { open: open.length, waiting: waiting.length, waitingOnMe: first ? { txId: first.id, postId: first.postId, title: clip(first.postTitle, TITLE_CHARS) } : null };
}

function enterpriseCard(c: Ctx): HomeCards['enterprise'] | undefined {
    built('enterprise');
    // §3.1 "`features.enterprises` on": enterprises AND treasuries (config/node-profile.ts getNodeFeatures), as this
    // answer's own `features` says, and as the enterprise's own screen answers (404 feature_off with treasuries off).
    if (!c.features.enterprises) return undefined;
    const kept = keeperOf(c.me!);
    if (!kept.length) return undefined;
    const id = kept[0];
    // Requests made to the enterprise that wait on its keepers: a trade asked of it, not yet accepted.
    const requests = (db.prepare("SELECT COUNT(*) AS c FROM marketplace_transactions WHERE seller_pubkey = ? AND status = 'requested'").get(id) as { c: number }).c;
    return { id, name: clip(getMember(id)?.callsign ?? '', NAME_CHARS), requests, others: kept.length - 1 };
}

/** The listings' read for this reader: a member's own visibility, or the visitors' view (nobody in it, rough areas). */
function postsFor(c: Ctx, filter: Parameters<typeof getPosts>[0]): MarketplacePost[] {
    const posts = getPosts({ ...filter, viewerPubkey: c.member ? c.me! : undefined, coarse: c.member ? undefined : true });
    return c.member ? posts : posts.map(guestPost);
}

function eventsCard(c: Ctx): HomeCards['events'] | undefined {
    built('events');
    // "Within 50 km" where the listings come nearest first (the global profile) and there is a point; elsewhere every event.
    const near = c.point && c.switches.distanceSortDefault ? c.point : null;
    const until = c.now + EVENT_DAYS * DAY_MS;
    // The soonest few in START order, in SQL (PostFilter.upcomingUntil): not the most recently updated, which an event
    // posted weeks ahead falls out of behind newer ones, and never every event on the node.
    const items = postsFor(c, {
        types: ['event'], status: 'active', upcomingUntil: iso(until), limit: EVENT_POOL,
        near: near ? { ...near, radiusKm: EVENTS_RADIUS_KM } : undefined, measureAtMost: near ? ONE_PASS_MAX_MEASURED : undefined,
    })
        .filter(p => p.status === 'active' && p.eventState !== 'cancelled' && !!bounded(p.eventStartAt, ID_CHARS) && !!bounded(p.id, ID_CHARS)
            && Date.parse(p.eventStartAt!) <= until && Date.parse(p.eventEndAt || p.eventStartAt!) > c.now)
        .sort((a, b) => Date.parse(a.eventStartAt!) - Date.parse(b.eventStartAt!))
        .slice(0, EVENT_ITEMS)
        .map((p): EventItem => ({
            id: p.id, title: clip(p.title, TITLE_CHARS), startsAt: p.eventStartAt!, endsAt: bounded(p.eventEndAt, ID_CHARS),
            // The typed place and the reader's own RSVP are a member's; a visitor gets "place shown after you join".
            place: c.member && p.eventPlaceName ? clip(p.eventPlaceName, NAME_CHARS) : null,
            rsvp: c.member ? p.myRsvp ?? null : null,
            ...(near ? { distanceKm: p.distanceKm ?? null } : {}),
        }));
    return items.length ? { items, radiusKm: near ? EVENTS_RADIUS_KM : null } : undefined;
}

function marketCard(c: Ctx): HomeCards['market'] | undefined {
    built('market');
    // Nearest first where the listings come that way (the global profile's "Near you") and there is a point; newest
    // first elsewhere. A distance on each wherever there is a point (every node understands one, G4).
    const near = c.point && c.switches.distanceSortDefault;
    const pool = postsFor(c, {
        types: ['offer', 'need'], limit: MARKET_POOL + 1,
        near: c.point ? { ...c.point } : undefined, sortByDistance: !!near, measureAtMost: c.point ? ONE_PASS_MAX_MEASURED : undefined,
    }).filter(p => p.status === 'active' && p.active !== false);
    const since = c.now - MARKET_DAYS * DAY_MS;
    const recent = pool.filter(p => Date.parse(p.createdAt) >= since);
    const shown = starredFirst(recent.filter(p => !!bounded(p.id, ID_CHARS)), p => p.category, c.member ? c.interests : [])
        .slice(0, c.member ? MARKET_ITEMS : VISITOR_MARKET_ITEMS)
        .map((p): MarketItem => ({
            // The category is only checked to be text when it is written (engine/post-fields.ts): cut like the title.
            id: p.id, type: p.type as 'offer' | 'need', title: clip(p.title, TITLE_CHARS), category: clip(String(p.category ?? ''), CATEGORY_CHARS),
            ...(c.switches.beans ? { credits: p.credits } : {}),
            photoUrl: p.photos?.[0] ?? null,
            ...(c.point ? { distanceKm: p.distanceKm ?? null } : {}),
        }));
    // The empty state (§6.1): on a node that asks for example cards, fewer than a handful of real listings in view.
    const examples = c.features.exampleListings && pool.length < EXAMPLES_BELOW;
    if (!shown.length && !examples) return undefined;
    return { items: shown, total14d: Math.min(recent.length, MARKET_POOL), more: recent.length > MARKET_POOL, ...(examples ? { examples: true as const } : {}) };
}

function decideCard(c: Ctx): HomeCards['decide'] | undefined {
    built('decide');
    const open = decisionsOn()
        ? getOpenDecisions().filter(d => !madeWithoutVote(d) && Date.parse(d.opensAt) <= c.now && Date.parse(d.closesAt) > c.now)
        : [];
    const soonest = open.map(d => d.closesAt).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
    const polls = getPosts({ type: 'poll', viewerPubkey: c.me!, limit: POLL_POOL + 1 })
        .filter(p => p.status === 'active' && !!p.pollClosesAt && Date.parse(p.pollClosesAt) > c.now);
    if (!open.length && !polls.length) return undefined;
    return { open: open.length, soonestClosesAt: soonest, polls: Math.min(polls.length, POLL_POOL), pollsMore: polls.length > POLL_POOL };
}

function groupsCard(c: Ctx): HomeCards['groups'] | undefined {
    built('groups');
    const all = chats(c).items;
    if (!all.length) return undefined;
    const items = [...all]
        .sort((a, b) => (b.unreadCount - a.unreadCount) || (b.lastActivityAt || '').localeCompare(a.lastActivityAt || ''))
        .slice(0, GROUP_ITEMS)
        .map(g => ({ id: g.conversationId, kind: g.kind as 'group' | 'enterprise' | 'event', name: clip(g.name, NAME_CHARS), unread: g.unreadCount, muted: muted(g.mute, c.now) }));
    return { items, total: all.length };
}

function joinedCard(c: Ctx): HomeCards['joined'] | undefined {
    built('joined');
    const since = iso(c.now - JOINED_DAYS * DAY_MS);
    // People who joined this week and are here now: no enterprise, no visitor's row, nobody pruned or suspended, no system
    // row (SYSTEM, which posts the node's own lines), and not the reader. The members list shows each of them to members already (joinedAt, a keyed face).
    const rows = db.prepare(`SELECT public_key, callsign, avatar_ref, area_lat, area_lng FROM members
                              WHERE joined_at >= ? AND status = 'active' AND COALESCE(is_treasury, 0) = 0 AND COALESCE(is_visitor, 0) = 0
                                AND length(public_key) = 64 AND public_key NOT GLOB '*[^0-9a-f]*' AND public_key != ?
                              ORDER BY joined_at DESC`).all(since, c.me!) as
        { public_key: string; callsign: string; avatar_ref: string | null; area_lat: number | null; area_lng: number | null }[];
    if (c.switches.guestListingsOnly) {
        // The global node (§3.1, §13 Q4): a count by area, never a name. Within 50 km of the reader's point, from each
        // person's own coarse area (G4), or everyone this week where the reader gave none and has set none.
        const p = c.point;
        const count = p ? rows.filter(r => r.area_lat != null && r.area_lng != null && haversineKm(p.lat, p.lng, r.area_lat, r.area_lng) <= JOINED_RADIUS_KM).length : rows.length;
        return count ? { count7d: count, radiusKm: p ? JOINED_RADIUS_KM : null } : undefined;
    }
    if (!rows.length) return undefined;
    return { count7d: rows.length, radiusKm: null, names: rows.slice(0, JOINED_NAMES).map(r => ({ callsign: clip(r.callsign, NAME_CHARS), avatarUrl: bounded(avatarUrlOf(r.public_key, r.avatar_ref), URL_CHARS) })) };
}

function pulseCard(c: Ctx): HomeCards['pulse'] | undefined {
    built('pulse');
    const since = c.now - PULSE_DAYS * DAY_MS;
    const recent = getPulseFeed({ limit: 6 }).items.filter(i => !!i.publishedAt && Date.parse(i.publishedAt) >= since);
    // An item whose id or platform a feed or a peer made long is left out; its link, past URL_CHARS, is no link (the
    // harvester stores a feed's links uncut: pulse-submit's MAX_ITEM_URL_LENGTH is for submissions).
    const usable = recent.filter(i => !!bounded(i.id, ID_CHARS) && !!bounded(i.platform, ID_CHARS));
    const items = starredFirst(usable, i => i.category, c.interests).slice(0, PULSE_ITEMS).map(i => ({
        id: i.id, title: i.title === null ? null : clip(i.title, TITLE_CHARS), platform: i.platform, callsign: clip(i.callsign, NAME_CHARS),
        category: clip(String(i.category ?? ''), CATEGORY_CHARS), url: bounded(i.url, URL_CHARS),
        // Through the node's own proxy (an <img> can't sign; no member's address reaches a CDN), as the Pulse screen.
        thumbnailUrl: i.thumbnailUrl ? `/api/pulse/items/${encodeURIComponent(i.id)}/thumbnail` : null,
    }));
    return items.length ? { items } : undefined;
}

/** H0b: the signer's own Beans and nothing else, where Beans are on. */
function beansCard(c: Ctx): HomeCards['beans'] | undefined {
    built('beans');
    if (!c.switches.beans) return undefined;
    const b = getBalance(c.me!);
    // Room to spend: down to the floor they may use (credit-model), never below nothing.
    return { balance: b.balance, room: Math.max(0, round2(b.balance - b.usableFloor)), tier: b.tier.name, activated: b.activated, frozen: b.frozen };
}

function noticesCard(c: Ctx): HomeCards['notices'] | undefined {
    built('notices');
    const unseen = listKeptNotices(c.me!, { unseenOnly: true });
    if (!unseen.length) return undefined;
    // The newest: the list is oldest first.
    const n = unseen[unseen.length - 1];
    return { unseen: unseen.length, first: { id: n.id, title: clip(n.title, TITLE_CHARS), line: clip((n.body || '').split('\n')[0], TITLE_CHARS) } };
}

function communityCard(c: Ctx): HomeCards['community'] {
    built('community');
    const config = getLocalConfig();
    const counts = getPublicCommunityInfo();
    const out: HomeCards['community'] = { name: config.communityName || config.callsign || null, members: counts.memberCount };
    // A community total, public by rule (privacy-defaults-2026-09-28): trades completed since the month began (UTC).
    if (c.switches.escrow) {
        const d = new Date(c.now);
        const monthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
        out.tradesThisMonth = (db.prepare("SELECT COUNT(*) AS c FROM marketplace_transactions WHERE status = 'completed' AND completed_at >= ?").get(monthStart) as { c: number }).c;
    }
    if (c.switches.directoryMirror) out.communities = listedCommunityCount();
    return out;
}

// ── the answer ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Which cards each part of a reader may have (the module's header). */
const OWN_CARDS: ReadonlySet<HomeCardId> = new Set(['needs', 'safety', 'steps', 'deals', 'enterprise', 'groups', 'beans', 'notices']);
const COMMUNITY_CARDS: ReadonlySet<HomeCardId> = new Set(['find', 'events', 'market', 'decide', 'joined', 'pulse']);

type Builder = (c: Ctx) => unknown;
const BUILDERS: Partial<Record<HomeCardId, Builder>> = {
    needs: needsCard, safety: safetyCard, find: findCard, steps: stepsCard, deals: dealsCard, enterprise: enterpriseCard,
    events: eventsCard, market: marketCard, decide: decideCard, groups: groupsCard, joined: joinedCard, pulse: pulseCard,
    beans: beansCard, notices: noticesCard, community: communityCard,
};

/** Whether this reader may have this card at all: their own cards, the community's, or the visitors' subset. */
function mayHave(c: Ctx, id: HomeCardId): boolean {
    if (id === 'community') return true;
    if (OWN_CARDS.has(id)) return c.own;
    if (COMMUNITY_CARDS.has(id)) return c.member || (c.guestView && VISITOR_CARDS.has(id));
    return false;
}

/**
 * The cards to compute: those asked for, or, with no `cards=`, every card but the ones the member's own layout hides
 * (never `needs` or `community`, nor `find` in a member's first 30 days), so a first landing with no copy of the layout
 * on the phone still skips a hidden card's work.
 */
function cardsToBuild(c: Ctx, asked: HomeCardId[] | undefined, layout: HomeLayout | null, joinedAt: string | null): HomeCardId[] {
    if (asked) return HOME_CARD_IDS.filter(id => asked.includes(id));
    const hidden = new Set(layout?.hidden ?? []);
    const joinedMs = joinedAt ? Date.parse(joinedAt) : NaN;
    const findPinned = !Number.isFinite(joinedMs) || c.now - joinedMs < FIND_PINNED_DAYS * DAY_MS;
    return HOME_CARD_IDS.filter(id => !hidden.has(id) || UNHIDEABLE.has(id) || (id === 'find' && findPinned));
}

/** The whole Home for this reader (the route has already refused a reader homeReaderStanding refuses). */
export function buildHome(reader: HomeReader): HomeAnswer {
    const now = reader.now ?? Date.now();
    const switches = getProfileSwitches();
    const me = reader.actor ?? null;
    const own = !!me && passesReadGate(me);
    const member = !!me && readsAsMember(me);
    const row = own ? getMember(me!) : undefined;
    const interests = own ? readInterests(me!) : [];
    const layout = own ? readHomeLayout(me!) : null;
    // The point the request gave, else the member's own coarse area (G4), which only they read back.
    const area = own ? readMemberArea(me!) : null;
    const point = reader.point ?? (member && area ? { lat: area.lat, lng: area.lng } : null);
    const features = getNodeFeatures();
    const c: Ctx = { me, own, member, guestView: !member && switches.guestListingsOnly, point, askedPoint: reader.point, now, switches, features, interests };

    const cards: HomeCards = {};
    for (const id of cardsToBuild(c, reader.asked, layout, row?.joinedAt ?? null)) {
        const build = BUILDERS[id];
        if (!build || !mayHave(c, id)) continue;
        // One card that can't be read is left out, never the whole screen (nothing on Home blocks the app): the next
        // read tries again, and the tag of an answer without it is a different tag.
        let card: unknown;
        try {
            card = build(c);
        } catch (e) {
            console.warn(`[Home] the ${id} card could not be read:`, (e as Error)?.message || e);
            continue;
        }
        if (card !== undefined) (cards as Record<string, unknown>)[id] = card;
    }

    let meBlock: HomeMe | null = null;
    if (own) {
        const probation = switches.probation ? probationSummary(me!, now) : null;
        meBlock = {
            joinedAt: row?.joinedAt ?? null,
            isKeeper: keeperOf(me!).length > 0,
            probation: probation?.onProbation ? probation : null,
            interests,
            area: area ? { lat: area.lat, lng: area.lng } : null,
            firstOffer: firstOfferOf(c),
            standing: member ? 'member' : 'suspended',
        };
    }
    return {
        generatedAt: iso(now),
        profile: getNodeProfile(),
        features: { ...features, door: getDoor() },
        // The visitors' Join card: for a reader with no account here only, never a suspended member (`me.standing`).
        ...(c.guestView && !own ? { welcome: true as const } : {}),
        me: meBlock,
        layout,
        cards,
    };
}

/** `cards=` as sent: a comma list, unknown ids dropped. Null when it is given more than once (a 400). */
export function parseAskedCards(raw: unknown): HomeCardId[] | undefined | null {
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string') return null;
    return [...new Set(raw.split(',').map(s => s.trim()).filter(isHomeCardId))];
}
