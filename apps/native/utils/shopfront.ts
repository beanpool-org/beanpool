/**
 * The shopfront on the phone (slice S5 of scratch/tools/DESIGN-shops-round3-enterprise-shopfront-fable.md §3, §6, on round
 * 2's shop page, DESIGN-shops-and-tools-fable.md §8; Marty's answers of 23 Oct 2026). One set of words and reads for the
 * two pages that are one shopfront: a member's shop (app/shop/[id].tsx) and an enterprise's page (app/treasury-detail.tsx),
 * drawn by components/shopfront/Shopfront.tsx.
 *
 * - What the node sends, read tolerantly: its listings (GET /api/marketplace/posts with `author=` or `shop=`: photos,
 *   the Featured stamp, the shop), the keepers of an enterprise with their badges (GET /api/treasury/:t, a member's read
 *   only: round 3 §5), and a shop (GET /api/shops/:id: a member's view, or a visitor's kind and counts).
 * - Featured: the shelf of up to six live Offers, the latest featured first (core SHOP_FEATURED_MAX).
 * - The sections: to buy, book a time, to borrow, and what an enterprise is looking for (its Needs).
 * - The badges are recognition and gate nothing (memory: tiers are merit badges); the page says so once.
 *
 * No answer is null, never an empty shop: a page says it couldn't read rather than showing nothing for sale.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SHOP_FEATURED_MAX, formatCount, formatDate, formatNumber, isShopKind, t, tn, tierIndexForName, TIER_LEVELS, type ShopKind, type TierName } from '@beanpool/core';
import { signedGet } from './db';
import { readShop, type MyShop } from './shop';
import { TIER_WORDS } from './trust-tier';

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
    /** Its first photo, on the node (the node's own 800 px copy, never a new one), or null. */
    photo: string | null;
}

const LIVE = new Set(['active', 'pending']);
const BY_TIME = new Set(['hourly', 'daily', 'weekly', 'monthly']);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** A listing as the node sends it, its photo made a URL on `anchor`; null for an event, a poll or anything else. */
export function readShopfrontListing(raw: unknown, anchor: string): ShopfrontListing | null {
    if (!raw || typeof raw !== 'object') return null;
    const p = raw as Record<string, unknown>;
    if (typeof p.id !== 'string' || !p.id || (p.type !== 'offer' && p.type !== 'need')) return null;
    const first = Array.isArray(p.photos) ? p.photos[0] : null;
    const photo = typeof first === 'string' && first.trim() ? (first.startsWith('/') ? `${anchor}${first}` : first) : null;
    const credits = typeof p.credits === 'number' && Number.isFinite(p.credits) ? p.credits : 0;
    return {
        id: p.id,
        type: p.type,
        title: typeof p.title === 'string' ? p.title : '',
        category: text(p.category),
        credits,
        priceType: typeof p.priceType === 'string' ? p.priceType : 'fixed',
        status: typeof p.status === 'string' ? p.status : 'active',
        lendable: p.lendable === true,
        featuredAt: text(p.featuredAt),
        shopId: text(p.shopId),
        photo,
    };
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

/** Its heading, with how many: a whole sentence per section. */
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

/** Its price in words, or null where the community shows no Beans (the worldwide one). */
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
}

/** The keepers as the node sends them, the lead first; a row with no key is none. */
export function readKeepers(raw: unknown): ShopfrontKeeper[] {
    if (!Array.isArray(raw)) return [];
    const rows: ShopfrontKeeper[] = [];
    for (const r of raw) {
        if (!r || typeof r !== 'object') continue;
        const k = r as Record<string, unknown>;
        const publicKey = typeof k.publicKey === 'string' ? k.publicKey : typeof k.pubkey === 'string' ? k.pubkey : '';
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

/** "since September 2026", from when it started; null when the node didn't say. */
export function sinceLine(since: unknown): string | null {
    if (typeof since !== 'string') return null;
    const d = new Date(since);
    if (Number.isNaN(d.getTime())) return null;
    return t('since {date}', { date: formatDate(d, 'month-year') }, 'how long a shop or enterprise has been here');
}

/** The money in one line (round 3 §0 row 9): its balance and its credit line. */
export function moneyLine(balance: number, creditLine: number): string {
    return t('{balance} 🫘 · credit line {credit} 🫘', { balance: formatNumber(balance), credit: formatNumber(creditLine) });
}

/**
 * Whether the node gave this reader the member's page: a node with the shopfront (it says `about` and `since`) gives the
 * keepers' categories to a member only (round 3 §5), so without them the reader sees a visitor's cut-off. An older node
 * says neither, and its page reads as it always did.
 */
export function readsAsMember(detail: unknown): boolean {
    if (!detail || typeof detail !== 'object') return false;
    const d = detail as Record<string, unknown>;
    if (!('about' in d) && !('since' in d)) return true;
    return Array.isArray(d.offerCategories);
}

// ── shops ───────────────────────────────────────────────────────────────────────────────────────

/** A shop as a member reads it, with whose it is. */
export interface ShopfrontShop extends MyShop {
    ownerPublicKey: string;
    enterprise: boolean;
}

/** A member's view of a shop (GET /api/shops/:id), or null when it is none (a visitor's view included). */
export function readShopfrontShop(raw: unknown): ShopfrontShop | null {
    const shop = readShop(raw);
    const s = raw as Record<string, unknown> | null;
    if (!shop || typeof s?.ownerPublicKey !== 'string' || !s.ownerPublicKey) return null;
    return { ...shop, ownerPublicKey: s.ownerPublicKey, enterprise: s.enterprise === true };
}

/** A shop's kind, when it is one of the fourteen. */
export function shopKindOf(raw: unknown): ShopKind | null {
    const kind = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).kind : null;
    return isShopKind(kind) ? kind : null;
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
        const res = await signedGet(`/api/shops/${encodeURIComponent(id)}`);
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

async function readListings(path: string): Promise<ShopfrontListing[] | null> {
    try {
        const res = await signedGet(path);
        if (!res.ok) return null;
        const json = await res.json().catch(() => null);
        if (!Array.isArray(json)) return null;
        const anchor = (await AsyncStorage.getItem('beanpool_anchor_url')) ?? '';
        return json.map((row) => readShopfrontListing(row, anchor)).filter((l): l is ShopfrontListing => !!l);
    } catch {
        return null;
    }
}

/** Every listing of `owner`'s the reader may see (an enterprise's Offers and Needs); null with no answer. */
export function readOwnerListings(owner: string): Promise<ShopfrontListing[] | null> {
    return readListings(`/api/marketplace/posts?author=${encodeURIComponent(owner)}&limit=200`);
}

/** A shop's Offers as the reader may see them; null with no answer. */
export function readShopListingsForReader(shopId: string): Promise<ShopfrontListing[] | null> {
    return readListings(`/api/marketplace/posts?shop=${encodeURIComponent(shopId)}&type=offer&limit=200`);
}
