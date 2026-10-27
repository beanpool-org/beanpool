/**
 * The shopfront on the web (slice S8 of scratch/tools/DESIGN-shops-round3-enterprise-shopfront-fable.md §3, §6; Marty's
 * answers of 23 Oct 2026): an enterprise's page is its shop's front window, drawn by components/Shopfront.tsx on
 * pages/TreasuryDetailPage.tsx, and its keepers' Manage tab (components/EnterpriseManage.tsx). The phone's words and reads
 * (apps/native/utils/shopfront.ts, S5), so both apps show the same things in the same order from the same fields.
 *
 * - What the node sends, read tolerantly: its listings (GET /api/marketplace/posts with `author=`: photos, the Featured
 *   stamp, the shop), the keepers with their badges (GET /api/treasury/:t, a member's read only: round 3 §5).
 * - Featured: the shelf of up to six live Offers, the latest featured first (core SHOP_FEATURED_MAX).
 * - The sections: to buy, book a time, to borrow, and what an enterprise is looking for (its Needs).
 * - The badges are recognition and gate nothing (memory: tiers are merit badges); the page says so once.
 * - Manage: the shelf as a keeper picks it, and the face's changes, each field to its own route.
 *
 * No answer is null, never an empty shop: a page says it couldn't read rather than showing nothing for sale.
 */
import {
    SHOP_FEATURED_MAX, TIER_LEVELS, formatCount, formatDate, formatNumber, isShopCategory, normalizeCategory, t, tierIndexForName, tn, word,
    type ShopCategory, type TierName, type WordKey,
} from '@beanpool/core';
import { getMarketplacePosts, signedFetch } from './api';
import { MARKETPLACE_CATEGORIES_BY_ID } from './marketplace';
import { readShop, type MyShop } from './shop';

// ── listings ────────────────────────────────────────────────────────────────────────────────────

/** One listing as the shopfront draws it: an Offer (in a section, maybe on the shelf) or an enterprise's Need. */
export interface ShopfrontListing {
    id: string;
    type: 'offer' | 'need';
    title: string;
    category: string | null;
    credits: number;
    /** 'fixed' for a total, else by the hour, day, week or month. */
    priceType: string;
    status: string;
    lendable: boolean;
    /** When it was put on the shop's shelf, or null. */
    featuredAt: string | null;
    shopId: string | null;
    /** Who it is for ('public', a group's, one person's), as the node says; null when not sent. Only a public one goes in a shop. */
    audienceScope: string | null;
    /** Its first photo, as the node sends it (its own 800 px copy, on this same origin), or null. */
    photo: string | null;
    /** The least credit of its author's tier, as every member reads it on a listing; null when not sent. */
    authorTierCredit: number | null;
}

const LIVE = new Set(['active', 'pending']);
const BY_TIME = new Set(['hourly', 'daily', 'weekly', 'monthly']);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** A listing as the node sends it; null for an event, a poll or anything else. */
export function readShopfrontListing(raw: unknown): ShopfrontListing | null {
    if (!raw || typeof raw !== 'object') return null;
    const p = raw as Record<string, unknown>;
    if (typeof p.id !== 'string' || !p.id || (p.type !== 'offer' && p.type !== 'need')) return null;
    const first = Array.isArray(p.photos) ? p.photos[0] : null;
    return {
        id: p.id,
        type: p.type,
        title: typeof p.title === 'string' ? p.title : '',
        category: text(p.category),
        credits: typeof p.credits === 'number' && Number.isFinite(p.credits) ? p.credits : 0,
        priceType: typeof p.priceType === 'string' ? p.priceType : 'fixed',
        status: typeof p.status === 'string' ? p.status : 'active',
        lendable: p.lendable === true,
        featuredAt: text(p.featuredAt),
        shopId: text(p.shopId),
        audienceScope: text(p.audienceScope),
        photo: typeof first === 'string' && first.trim() ? first : null,
        authorTierCredit: typeof p.authorEnergyCycled === 'number' && Number.isFinite(p.authorEnergyCycled) ? p.authorEnergyCycled : null,
    };
}

/**
 * The text listings an enterprise's detail carries (GET /api/treasury/:t `posts`, for every app since before shops), as
 * the shopfront draws them: no photo and no stamp, so they fill the sections when its listings with photos can't be read.
 */
export function listingsFromDetailPosts(posts: unknown): ShopfrontListing[] {
    if (!Array.isArray(posts)) return [];
    return posts
        .map((p) => {
            if (!p || typeof p !== 'object') return null;
            const row = p as Record<string, unknown>;
            return readShopfrontListing({ ...row, priceType: row.price_type ?? row.priceType, photos: [], featuredAt: null });
        })
        .filter((l): l is ShopfrontListing => !!l);
}

/** The shelf: its live featured Offers, the latest featured first, at most six. */
export function featuredOf(listings: readonly ShopfrontListing[]): ShopfrontListing[] {
    return listings
        .filter((l) => l.type === 'offer' && l.featuredAt && LIVE.has(l.status))
        .sort((a, b) => (b.featuredAt! < a.featuredAt! ? -1 : b.featuredAt! > a.featuredAt! ? 1 : 0))
        .slice(0, SHOP_FEATURED_MAX);
}

export type ShopSectionId = 'toBuy' | 'byTime' | 'toBorrow' | 'lookingFor';
export interface ShopSection { id: ShopSectionId; title: string; listings: ShopfrontListing[] }

/** Its heading, with how many: a whole sentence per section (the phone's keys). */
function sectionTitle(id: ShopSectionId, n: number): string {
    const values = { n: formatCount(n) };
    if (id === 'toBuy') return t('To buy ({n})', values, 'a shop section: things for sale');
    if (id === 'byTime') return t('Book a time ({n})', values, 'a shop section: help priced by the hour or day');
    if (id === 'toBorrow') return t('To borrow ({n})', values, 'a shop section: things to lend');
    return t('Looking for ({n})', values, "a shop section: an enterprise's Needs");
}

/**
 * Its live listings in sections, in this order, each left out when empty: to buy (a total), book a time (priced by the
 * hour, day, week or month), to borrow (lendable), and what it is looking for (its Needs). A paused or ended one in none.
 */
export function shopSectionsOf(listings: readonly ShopfrontListing[]): ShopSection[] {
    const groups: Record<ShopSectionId, ShopfrontListing[]> = { toBuy: [], byTime: [], toBorrow: [], lookingFor: [] };
    for (const l of listings) {
        if (!LIVE.has(l.status)) continue;
        if (l.type === 'need') groups.lookingFor.push(l);
        else if (l.lendable) groups.toBorrow.push(l);
        else if (BY_TIME.has(l.priceType)) groups.byTime.push(l);
        else groups.toBuy.push(l);
    }
    return (['toBuy', 'byTime', 'toBorrow', 'lookingFor'] as const)
        .filter((id) => groups[id].length > 0)
        .map((id) => ({ id, title: sectionTitle(id, groups[id].length), listings: groups[id] }));
}

/** Its price in words, or null where the community shows no Beans. */
export function listingPriceLine(l: ShopfrontListing, showsBeans: boolean): string | null {
    if (!showsBeans) return null;
    const amount = formatNumber(l.credits);
    if (l.priceType === 'hourly') return t('{amount} 🫘 an hour', { amount });
    if (l.priceType === 'daily') return t('{amount} 🫘 a day', { amount });
    if (l.priceType === 'weekly') return t('{amount} 🫘 a week', { amount });
    if (l.priceType === 'monthly') return t('{amount} 🫘 a month', { amount });
    if (l.credits === 0) return t('Free', undefined, 'a listing with no price');
    return t('{amount} 🫘', { amount });
}

/** What one of its listings is doing now, when it is not simply on the board. */
export function listingStateLine(l: ShopfrontListing): string | null {
    if (l.status !== 'pending') return null;
    return l.lendable ? t('Out on loan') : t('In a deal');
}

/** A category's emoji: an older id is today's (core normalizeCategory), anything unknown is General's. */
export function categoryEmoji(id: string | null | undefined): string {
    return MARKETPLACE_CATEGORIES_BY_ID.get(normalizeCategory(id))?.emoji ?? '🌱';
}

/** A category's name in the member's language. */
export function categoryLabel(id: string | null | undefined): string {
    const c = MARKETPLACE_CATEGORIES_BY_ID.get(normalizeCategory(id));
    return c ? t(c.label) : t('General');
}

// ── keepers ─────────────────────────────────────────────────────────────────────────────────────

/** A keeper as the shopfront draws them: their badges only when the node gave them (a member's read). */
export interface ShopfrontKeeper {
    publicKey: string;
    callsign: string;
    avatarUrl: string | null;
    isLead: boolean;
    suspended: boolean;
    tier: TierName | null;
    rating: { average: number; count: number } | null;
    trades: number | null;
    /** What they back it with, in Beans (0 when the node says none). */
    backing: number;
}

/** Each tier's name as a member reads it (the phone's utils/trust-tier.ts keys). */
const TIER_WORDS: Readonly<Record<TierName, WordKey>> = {
    Newcomer: word('Newcomer', 'trust tier'),
    Resident: word('Resident', 'trust tier'),
    Steward: word('Steward', 'trust tier'),
    Elder: word('Elder', 'trust tier'),
};

/** The keepers as the node sends them, the lead first; a row with no key is none. Older payloads say `pubkey`. */
export function readKeepers(raw: unknown): ShopfrontKeeper[] {
    if (!Array.isArray(raw)) return [];
    const rows: ShopfrontKeeper[] = [];
    for (const r of raw) {
        if (!r || typeof r !== 'object') continue;
        const k = r as Record<string, unknown>;
        const publicKey = [k.publicKey, k.pubkey, k.memberPubkey].find((v): v is string => typeof v === 'string' && !!v) ?? '';
        if (!publicKey) continue;
        const rating = k.rating && typeof k.rating === 'object' ? k.rating as Record<string, unknown> : null;
        rows.push({
            publicKey,
            callsign: typeof k.callsign === 'string' ? k.callsign : '',
            avatarUrl: text(k.avatarUrl),
            isLead: k.role === 'lead',
            suspended: !!k.suspended,
            tier: tierIndexForName(k.tier as string) >= 0 ? k.tier as TierName : null,
            rating: rating && typeof rating.average === 'number' && typeof rating.count === 'number' ? { average: rating.average, count: rating.count } : null,
            trades: typeof k.trades === 'number' && Number.isFinite(k.trades) ? k.trades : null,
            backing: Number(k.backing) > 0 ? Number(k.backing) : 0,
        });
    }
    return rows.sort((a, b) => Number(b.isLead) - Number(a.isLead));
}

/** "🏠 Resident · ★★★★★ · 14 trades": their tier, their stars when rated, their trades; null without badges. */
export function keeperBadgeLine(k: ShopfrontKeeper): string | null {
    if (!k.tier) return null;
    const tier = TIER_LEVELS[tierIndexForName(k.tier)];
    const parts = [t('{emoji} {tier}', { emoji: tier.emoji, tier: t(TIER_WORDS[k.tier]) }, 'a trust tier, after its emoji')];
    if (k.rating && k.rating.count > 0) {
        const stars = Math.max(0, Math.min(5, Math.round(k.rating.average)));
        parts.push('★'.repeat(stars) + '☆'.repeat(5 - stars));
    }
    if (k.trades !== null) parts.push(tn(k.trades, '{n} trade', '{n} trades', { n: formatCount(k.trades) }));
    return parts.join(' · ');
}

/** A keeper's part, in their kind's words: a project's leader and collaborators, an enterprise's lead keeper and keepers. */
export function keeperRoleWord(project: boolean, isLead: boolean): string {
    if (project) return isLead ? t('Leader', undefined, 'project role') : t('Collaborator', undefined, 'project role');
    return isLead ? t('Lead keeper', undefined, 'enterprise role') : t('Keeper', undefined, 'enterprise role');
}

/** Who "Message" writes to: the lead keeper, else the only keeper; nobody when it can't say which. */
export function leadKeeperOf(keepers: readonly ShopfrontKeeper[]): ShopfrontKeeper | null {
    return keepers.find((k) => k.isLead) ?? (keepers.length === 1 ? keepers[0] : null);
}

/** The Message button: to an enterprise's lead keeper, a project's leader, or a shop's owner, named. */
export function messageLabel(name: string, kind: 'enterprise' | 'project' | 'shop'): string {
    if (kind === 'enterprise') return t('Message {name} (lead keeper)', { name });
    if (kind === 'project') return t('Message {name} (leader)', { name });
    return t('Message {name}', { name });
}

// ── lines ───────────────────────────────────────────────────────────────────────────────────────

/**
 * A shop's category as it is shown: the emoji and the words its listings have for it (categoryEmoji, categoryLabel), so a
 * shop and its listings always agree: "💻 Tech & Digital". It picks the tools shown and where the shop's new listings
 * start, and gates nothing.
 */
export function shopCategoryLabel(category: ShopCategory): string {
    return t('{emoji} {label}', { emoji: categoryEmoji(category), label: categoryLabel(category) });
}

/** A shop's category, when it is one of the Market's (core SHOP_CATEGORIES). */
export function shopCategoryOf(raw: unknown): ShopCategory | null {
    const category = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).category : null;
    return isShopCategory(category) ? category : null;
}

/** A shop's banner, its one photo's URL as the node gave it (keyed), or null: none, or a node from before banners. */
export function shopPhotoOf(raw: unknown): string | null {
    const url = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).photoUrl : null;
    return typeof url === 'string' && url !== '' ? url : null;
}

/** "since Sep 2026", from when it started; null when the node didn't say. */
export function sinceLine(since: unknown): string | null {
    if (typeof since !== 'string') return null;
    const d = new Date(since);
    if (Number.isNaN(d.getTime())) return null;
    return t('since {date}', { date: formatDate(d, 'month-year') }, 'how long a shop or enterprise has been here');
}

/** Its category and since when, in one line: "💻 Tech & Digital · since Sep 2026". */
export function categorySinceLine(category: ShopCategory | null, since: string | null): string | null {
    const parts = [category ? shopCategoryLabel(category) : null, since].filter((p): p is string => !!p);
    return parts.length ? parts.join(' · ') : null;
}

/** The money in one line (round 3 §0 row 9): its balance and its credit line. */
export function moneyLine(balance: number, creditLine: number): string {
    return t('{balance} 🫘 · credit line {credit} 🫘', { balance: formatNumber(balance), credit: formatNumber(creditLine) });
}

/** Whether an enterprise's detail is from a node with the shopfront (E2: it says `about` and `since`). */
export function hasShopfront(detail: unknown): boolean {
    if (!detail || typeof detail !== 'object') return false;
    return 'about' in detail || 'since' in detail;
}

/**
 * Whether the node gave this reader the member's page: a node with the shopfront gives the keepers' categories to a
 * member only (round 3 §5), so without them the reader sees a visitor's cut-off. An older node says neither, and its page
 * reads as it always did.
 */
export function readsAsMember(detail: unknown): boolean {
    if (!detail || typeof detail !== 'object') return false;
    if (!hasShopfront(detail)) return true;
    return Array.isArray((detail as Record<string, unknown>).offerCategories);
}

// ── Manage ──────────────────────────────────────────────────────────────────────────────────────

/** The shelf as its keepers pick it: its live Offers in its shop, how many are featured, and those not in it yet. */
export interface Shelf {
    inShop: ShopfrontListing[];
    /** Featured now, a paused one included: the node counts it, so a resume never makes seven. */
    featured: number;
    /** Its live Offers for everyone that are in no shop yet, so can't be featured until they go in. */
    outside: ShopfrontListing[];
}

export function shelfOf(listings: readonly ShopfrontListing[], shopId: string | null): Shelf {
    const offers = listings.filter((l) => l.type === 'offer');
    const inShop = shopId ? offers.filter((l) => l.shopId === shopId && LIVE.has(l.status)) : [];
    const featured = shopId ? offers.filter((l) => l.shopId === shopId && l.featuredAt && (LIVE.has(l.status) || l.status === 'paused')).length : 0;
    const outside = offers.filter((l) => !l.shopId && l.status === 'active' && (l.audienceScope ?? 'public') === 'public');
    return { inShop, featured, outside };
}

/** "2 of 6 on the shelf". */
export function shelfLine(n: number): string {
    return t('{n} of {max} on the shelf', { n: formatCount(n), max: formatCount(SHOP_FEATURED_MAX) });
}

/** The face a keeper edits: what the profile route and the shop route each hold. */
export interface Face {
    name: string;
    purpose: string;
    about: string;
    category: ShopCategory | null;
    howToDeal: string;
    /** A new logo, the picture the keeper chose (already the 800 px copy); absent for no change. */
    avatar?: string;
    /** Its banner: a new photo the keeper chose (already the 800 px copy), null to take it down; absent for no change. */
    banner?: string | null;
}

/**
 * What one Save sends, each field that changed to its own route: the name and purpose only from the lead (or an admin),
 * About and the logo from any keeper (PUT /api/treasury/:t/profile); the category, how we deal and the banner photo from a
 * keeper, who may change its shop (PUT /api/treasury/:t/shop). Words are sent trimmed, as the node keeps them; how we deal
 * emptied is none (null), and so is a banner taken down.
 */
export function faceChanges(was: Face, now: Face, may: { lead: boolean; shop: boolean }): { profile: Record<string, string>; shop: Record<string, string | null> } {
    const profile: Record<string, string> = {};
    const shop: Record<string, string | null> = {};
    const trimmed = (s: string) => s.trim();
    if (may.lead && trimmed(now.name) !== trimmed(was.name)) profile.name = trimmed(now.name);
    if (may.lead && trimmed(now.purpose) !== trimmed(was.purpose)) profile.purpose = trimmed(now.purpose);
    if (trimmed(now.about) !== trimmed(was.about)) profile.about = trimmed(now.about);
    if (now.avatar) profile.avatar = now.avatar;
    if (may.shop && now.category !== was.category) shop.category = now.category;
    if (may.shop && trimmed(now.howToDeal) !== trimmed(was.howToDeal)) shop.howToDeal = trimmed(now.howToDeal) || null;
    if (may.shop && now.banner !== undefined) shop.photo = now.banner;
    return { profile, shop };
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────────

/** Every listing of `owner`'s the reader may see (an enterprise's Offers and Needs, with photos and stamps); null with no answer. */
export async function readOwnerListings(owner: string, opts?: { keeper?: boolean }): Promise<ShopfrontListing[] | null> {
    try {
        const rows: unknown = await getMarketplacePosts({ author: owner, limit: 200, keeper: opts?.keeper });
        if (!Array.isArray(rows)) return null;
        return rows.map((row) => readShopfrontListing(row)).filter((l): l is ShopfrontListing => !!l);
    } catch {
        return null;
    }
}

// ── shops ───────────────────────────────────────────────────────────────────────────────────────

/** A shop as a member reads it, with whose it is. */
export interface ShopfrontShop extends MyShop {
    ownerPublicKey: string;
    enterprise: boolean;
    /** When it opened, or null. */
    openedAt: string | null;
}

/** A member's view of a shop (GET /api/shops/:id), or null when it is none (a visitor's view included). */
export function readShopfrontShop(raw: unknown): ShopfrontShop | null {
    const shop = readShop(raw);
    const s = raw as Record<string, unknown> | null;
    if (!shop || typeof s?.ownerPublicKey !== 'string' || !s.ownerPublicKey) return null;
    return { ...shop, ownerPublicKey: s.ownerPublicKey, enterprise: s.enterprise === true, openedAt: text(s.openedAt) };
}

/** A shop's page: a member's shop, an enterprise's (its own page draws it), a visitor's view, none, or no answer. */
export type ShopPageRead =
    | { state: 'shop'; shop: ShopfrontShop }
    | { state: 'enterprise'; ownerPublicKey: string; name: string }
    | { state: 'visitor' }
    | { state: 'none' }
    | { state: 'offline' };

export async function readShopPage(id: string): Promise<ShopPageRead> {
    try {
        const res = await signedFetch('GET', `/api/shops/${encodeURIComponent(id)}`);
        if (res.status === 404) return { state: 'none' };
        if (!res.ok) return { state: 'offline' };
        const json = await res.json().catch(() => null);
        if (json && typeof json === 'object' && typeof (json as Record<string, unknown>).id === 'string' && !('ownerPublicKey' in json)) return { state: 'visitor' };
        const shop = readShopfrontShop(json);
        if (!shop) return { state: 'offline' };
        if (shop.enterprise) return { state: 'enterprise', ownerPublicKey: shop.ownerPublicKey, name: shop.name ?? shop.ownerName };
        return { state: 'shop', shop };
    } catch {
        return { state: 'offline' };
    }
}

/** A shop's Offers as the reader may see them; null with no answer. */
export async function readShopListingsForReader(shopId: string): Promise<ShopfrontListing[] | null> {
    try {
        const res = await signedFetch('GET', `/api/marketplace/posts?shop=${encodeURIComponent(shopId)}&type=offer&limit=200`);
        if (!res.ok) return null;
        const json = await res.json().catch(() => null);
        if (!Array.isArray(json)) return null;
        return json.map((row) => readShopfrontListing(row)).filter((l): l is ShopfrontListing => !!l);
    } catch {
        return null;
    }
}

