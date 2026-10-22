/**
 * A member's own shop on the phone (slice S4′ of scratch/tools/DESIGN-tool-template-fable.md §6; the shop model of
 * DESIGN-shops-and-tools-fable.md §2.1, §8, §9.1, and Marty's additions of 19 Oct 2026): a front window on their own
 * account, with a name, a kind, a blurb, "how I deal", and the Offers they put in it. This reads and changes it through
 * the node's routes in their real shapes (apps/server routes/shops.ts), signed as the member, and says it in words.
 *
 * - The node's answers: GET /api/shops/mine `{ shop | null }`; PUT `{ shop, paused, resumed }` with the Offers it moved
 *   as id lists; the close `{ cleared, ended, resumed }` as counts; "Add my live Offers" `{ added }` as ids. The phone
 *   wants how many in each case, and reads a list or a number alike ({@link movedCount}), so it depends on neither shape.
 * - A refusal is thrown as the node's own sentence, with its status and code (utils/db.ts signedRequestWithMethod), so a
 *   screen says why: open deals (409 shop_deals_open), a shop closed for now (409 shop_paused), a muted member (403).
 * - A shop's name is the member's own words, shown as written; with none, "<their name>'s shop" in their language.
 *
 * Only the member's own shop: an enterprise's shopfront is a later slice (S7), and the Market side is S5.
 */
import { SHOP_KINDS, formatCount, formatDate, isShopKind, t, tn, word, type ShopCounts, type ShopKind, type WordKey } from '@beanpool/core';
import { signedGet, signedRequestWithMethod } from './db';

/** The member's own shop, as the phone draws it. */
export interface MyShop {
    id: string;
    /** Their own name for it, or null: then it is "<ownerName>'s shop" ({@link shopTitle}). */
    name: string | null;
    ownerName: string;
    kind: ShopKind | null;
    blurb: string | null;
    howToDeal: string | null;
    counts: ShopCounts;
    /** Closed for now, and the day it says it is back (YYYY-MM-DD), if it says one. */
    paused: boolean;
    backOn: string | null;
}

/** What a change names: each field optional, null or empty text clears one (engine/shops.ts ShopChanges). */
export interface MyShopChanges {
    name?: string | null;
    kind?: ShopKind | null;
    blurb?: string | null;
    howToDeal?: string | null;
    paused?: boolean;
    backOn?: string | null;
}

/** The fourteen kinds (core SHOP_KINDS), each an emoji and its words. A kind picks the tools shown and gates nothing. */
export const SHOP_KIND_WORDS: Readonly<Record<ShopKind, { emoji: string; name: WordKey }>> = {
    tools: { emoji: '🛠️', name: word('Tools and equipment') },
    food: { emoji: '🥕', name: word('Food from the garden or farm') },
    baking: { emoji: '🍞', name: word('Cooked food and baking') },
    repairs: { emoji: '🔧', name: word('Repairs') },
    crafts: { emoji: '🎨', name: word('Making and crafts') },
    lessons: { emoji: '📚', name: word('Lessons and tutoring') },
    care: { emoji: '❤️', name: word('Care') },
    rides: { emoji: '🚲', name: word('Rides and deliveries') },
    rooms: { emoji: '🏠', name: word('Rooms, space and stays') },
    buying: { emoji: '🧺', name: word('Buying together') },
    seeds: { emoji: '🌱', name: word('Seeds and seedlings') },
    energy: { emoji: '☀️', name: word('Water, power and fuel') },
    animals: { emoji: '🐾', name: word('Animals and produce') },
    labour: { emoji: '👷', name: word('Hands and labour') },
};
export const SHOP_KIND_IDS: readonly ShopKind[] = SHOP_KINDS;

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A shop as the node sends it (engine/shops.ts MemberShop), read tolerantly; null for anything that is no shop. */
export function readShop(raw: unknown): MyShop | null {
    if (!raw || typeof raw !== 'object') return null;
    const s = raw as Record<string, unknown>;
    if (typeof s.id !== 'string' || !s.id) return null;
    const c = (s.counts && typeof s.counts === 'object' ? s.counts : {}) as Record<string, unknown>;
    return {
        id: s.id,
        name: text(s.name),
        ownerName: typeof s.ownerName === 'string' ? s.ownerName : '',
        kind: isShopKind(s.kind) ? s.kind : null,
        blurb: text(s.blurb),
        howToDeal: text(s.howToDeal),
        counts: { things: count(c.things), available: count(c.available), toBorrow: count(c.toBorrow), toBuy: count(c.toBuy), out: count(c.out), newThisWeek: count(c.newThisWeek) },
        paused: s.paused === true,
        backOn: typeof s.backOn === 'string' && DAY.test(s.backOn) ? s.backOn : null,
    };
}

/** How many Offers a change moved, whichever way the node says it: a count, or the list of their ids. */
export function movedCount(v: unknown): number {
    if (Array.isArray(v)) return v.length;
    return count(v);
}

/** The member's own shop: none yet, open (closed for now included), a node from before shops, or no answer. */
export type MyShopRead = { state: 'none' } | { state: 'open'; shop: MyShop } | { state: 'older' } | { state: 'offline' };

export async function readMyShop(): Promise<MyShopRead> {
    try {
        const res = await signedGet('/api/shops/mine');
        if (res.status === 404) return { state: 'older' };
        if (!res.ok) return { state: 'offline' };
        const json = await res.json().catch(() => null) as { shop?: unknown } | null;
        if (json && json.shop === null) return { state: 'none' };
        const shop = readShop(json?.shop);
        return shop ? { state: 'open', shop } : { state: 'offline' };
    } catch {
        return { state: 'offline' };
    }
}

const UNREADABLE = () => new Error(t("Your shop couldn't be read just now. Try again."));

async function write(method: 'PUT' | 'POST', path: string, body: unknown): Promise<Record<string, unknown>> {
    const json = await signedRequestWithMethod(method, path, body, { withStatus: true });
    return (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
}

/** Opens the member's shop if need be ({} opens it as it is), then changes what `changes` names. */
export async function changeMyShop(changes: MyShopChanges): Promise<{ shop: MyShop; paused: number; resumed: number }> {
    const json = await write('PUT', '/api/shops/mine', changes);
    const shop = readShop(json.shop);
    if (!shop) throw UNREADABLE();
    return { shop, paused: movedCount(json.paused), resumed: movedCount(json.resumed) };
}

/** Closes the member's shop: its Offers stay in the Market on their own, or end with `endOffers`. */
export async function closeMyShop(endOffers: boolean): Promise<{ cleared: number; ended: number; resumed: number }> {
    const json = await write('POST', '/api/shops/mine/close', { endOffers });
    return { cleared: movedCount(json.cleared), ended: movedCount(json.ended), resumed: movedCount(json.resumed) };
}

/** "Add my live Offers": puts these in the member's shop, all or none; how many went in. */
export async function addOffersToMyShop(postIds: string[]): Promise<number> {
    const json = await write('POST', '/api/shops/mine/offers', { postIds });
    return movedCount(json.added);
}

// ── listings ────────────────────────────────────────────────────────────────────────────────────

/** One of the member's Offers, as Your shop lists it. */
export interface ShopListing {
    id: string;
    title: string;
    status: string;
    lendable: boolean;
    shopId: string | null;
    audienceScope: string;
    originNode: string | null;
    /** Its first photo as the node gives it (a path on the node), or null. */
    photo: string | null;
}

function readListing(raw: unknown): ShopListing | null {
    if (!raw || typeof raw !== 'object') return null;
    const p = raw as Record<string, unknown>;
    if (typeof p.id !== 'string' || !p.id || p.type !== 'offer') return null;
    const photos = Array.isArray(p.photos) ? p.photos : [];
    return {
        id: p.id,
        title: typeof p.title === 'string' ? p.title : '',
        status: typeof p.status === 'string' ? p.status : 'active',
        lendable: p.lendable === true,
        shopId: typeof p.shopId === 'string' && p.shopId ? p.shopId : null,
        audienceScope: typeof p.audienceScope === 'string' ? p.audienceScope : 'public',
        originNode: typeof p.originNode === 'string' && p.originNode ? p.originNode : null,
        photo: typeof photos[0] === 'string' ? photos[0] : null,
    };
}

async function readListings(path: string): Promise<ShopListing[] | null> {
    try {
        const res = await signedGet(path);
        if (!res.ok) return null;
        const json = await res.json().catch(() => null);
        return Array.isArray(json) ? json.map(readListing).filter((l): l is ShopListing => !!l) : null;
    } catch {
        return null;
    }
}

/** The shop's Offers as its owner reads them (`shop=` with `author=`: the paused ones too); null with no answer. */
export function readShopListings(shopId: string, me: string): Promise<ShopListing[] | null> {
    return readListings(`/api/marketplace/posts?shop=${encodeURIComponent(shopId)}&author=${encodeURIComponent(me)}&type=offer&limit=200`);
}

/** The member's own Offers, for "Add my live Offers"; null with no answer. */
export function readMyLiveOffers(me: string): Promise<ShopListing[] | null> {
    return readListings(`/api/marketplace/posts?author=${encodeURIComponent(me)}&type=offer&limit=200`);
}

/**
 * The Offers "Add my live Offers" offers: the member's own that the node would take (engine/shops.ts addOffersToShop):
 * live (on the board, or in a deal), for everyone here, this community's own, and not in the shop already.
 */
export function offersToAdd(listings: readonly ShopListing[], shopId: string): ShopListing[] {
    return listings.filter((l) => (l.status === 'active' || l.status === 'pending') && l.audienceScope === 'public' && !l.originNode && l.shopId !== shopId);
}

/** Which shop one listing is in as the node says now: its id, null for none, undefined when it can't be read. */
export async function readListingShopId(postId: string): Promise<string | null | undefined> {
    const rows = await readListings(`/api/marketplace/posts?id=${encodeURIComponent(postId)}`);
    const row = rows?.find((l) => l.id === postId);
    return row ? row.shopId : undefined;
}

// ── words ───────────────────────────────────────────────────────────────────────────────────────

/** A shop's title: the member's own name for it, else "<their name>'s shop" in the reader's language. */
export function shopTitle(shop: { name: string | null; ownerName: string }): string {
    if (shop.name?.trim()) return shop.name;
    return shop.ownerName.trim() ? t("{name}'s shop", { name: shop.ownerName }) : t('Your shop');
}

/** "3 things · 1 out", or "Nothing in it yet". */
export function shopCountsLine(counts: ShopCounts): string {
    if (counts.things === 0) return t('Nothing in it yet');
    const parts = [tn(counts.things, '{n} thing', '{n} things', { n: formatCount(counts.things) })];
    if (counts.out > 0) parts.push(t('{n} out', { n: formatCount(counts.out) }, 'things lent out now'));
    return parts.join(' · ');
}

/** A day kept as YYYY-MM-DD, as a date on the member's own clock. */
export function dayOf(day: string): Date {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(y, m - 1, d);
}

/** Closed for now (and when it is back), else the counts. */
export function shopStateLine(shop: { paused: boolean; backOn: string | null; counts: ShopCounts }): string {
    if (!shop.paused) return shopCountsLine(shop.counts);
    if (!shop.backOn) return t('Closed for now');
    return t('Closed for now · back {date}', { date: formatDate(dayOf(shop.backOn), 'weekday-day-month') });
}

/** Today on the member's own clock, as YYYY-MM-DD. */
export function localDay(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export type BackOnChoice = 'none' | 'week' | 'fortnight' | 'month';
/** When a shop closed for now says it is back: not said, or a week, two weeks or a month from today, on the member's clock. */
export function backOnChoices(now: Date): Array<{ id: BackOnChoice; day: string | null; label: string }> {
    const after = (days: number) => localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
    return [
        { id: 'none', day: null, label: t("Don't say") },
        { id: 'week', day: after(7), label: t('In a week') },
        { id: 'fortnight', day: after(14), label: t('In two weeks') },
        { id: 'month', day: after(30), label: t('In a month') },
    ];
}
