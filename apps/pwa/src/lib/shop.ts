/**
 * A member's own shop on the web (parity with apps/native/utils/shop.ts, slice S4′ of
 * scratch/tools/DESIGN-tool-template-fable.md §6): a front window on their own account, with a name,
 * a category, a blurb, "how I deal", and the Offers they put in it.
 */
import {
    formatCount, formatDate, isShopCategory, t, tn,
    type ShopCategory, type ShopCounts,
} from '@beanpool/core';
import { request, signedFetch } from './api';
import { categoryEmoji, categoryLabel } from './shopfront';

/** The member's own shop, as the web app draws it. */
export interface MyShop {
    id: string;
    /** Their own name for it, or null: then it is "<ownerName>'s shop" ({@link shopTitle}). */
    name: string | null;
    ownerName: string;
    /** One of the Market's categories (core SHOP_CATEGORIES), or null: none chosen, or one this build doesn't know. */
    category: ShopCategory | null;
    blurb: string | null;
    howToDeal: string | null;
    counts: ShopCounts;
    /** Closed for now, and the day it says it is back (YYYY-MM-DD), if it says one. */
    paused: boolean;
    backOn: string | null;
    /** Its banner photo's address on its community, or null. */
    photoUrl: string | null;
}

/** Home's "Your shop and tools" as the node sends it (`cards.shop`). */
export interface ShopHomeCard {
    shop: { id: string; name: string | null; ownerName: string; category: string | null; counts: ShopCounts; paused: boolean; backOn: string | null } | null;
}

/** What a change names: each field optional, null or empty text clears one. */
export interface MyShopChanges {
    name?: string | null;
    category?: ShopCategory | null;
    blurb?: string | null;
    howToDeal?: string | null;
    paused?: boolean;
    backOn?: string | null;
    /** Its banner: a photo (JPEG data URL or path), or null to take it down. */
    photo?: string | null;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A shop as the node sends it, read tolerantly; null for anything that is no shop. */
export function readShop(raw: unknown): MyShop | null {
    if (!raw || typeof raw !== 'object') return null;
    const s = raw as Record<string, unknown>;
    if (typeof s.id !== 'string' || !s.id) return null;
    const c = (s.counts && typeof s.counts === 'object' ? s.counts : {}) as Record<string, unknown>;
    return {
        id: s.id,
        name: text(s.name),
        ownerName: typeof s.ownerName === 'string' ? s.ownerName : '',
        category: isShopCategory(s.category) ? s.category : null,
        blurb: text(s.blurb),
        howToDeal: text(s.howToDeal),
        counts: { things: count(c.things), available: count(c.available), toBorrow: count(c.toBorrow), toBuy: count(c.toBuy), out: count(c.out), newThisWeek: count(c.newThisWeek) },
        paused: s.paused === true,
        backOn: typeof s.backOn === 'string' && DAY.test(s.backOn) ? s.backOn : null,
        photoUrl: text(s.photoUrl),
    };
}

/** How many Offers a change moved, whichever way the node says it: a count, or the list of their ids. */
export function movedCount(v: unknown): number {
    if (Array.isArray(v)) return v.length;
    return count(v);
}

/** The member's own shop: none yet, open (closed for now included), a node from before shops, or no answer. */
export type MyShopRead = { state: 'none' } | { state: 'open'; shop: MyShop } | { state: 'older' } | { state: 'offline' };

export const SHOP_TOGGLE_READ_MS = 5_000;
export const SHOP_COMPOSER_WAIT_MS = 5_000;

/** `timeoutMs`: past it, the read is let go and is no answer (offline). Without one, it waits as long as the fetch does. */
export async function readMyShop(options: { timeoutMs?: number } = {}): Promise<MyShopRead> {
    const stop = options.timeoutMs ? new AbortController() : null;
    const timer = stop ? setTimeout(() => stop.abort(), options.timeoutMs) : null;
    try {
        const res = await signedFetch('GET', '/api/shops/mine', undefined, stop?.signal);
        if (res.status === 404) return { state: 'older' };
        if (!res.ok) return { state: 'offline' };
        const json = await res.json().catch(() => null) as { shop?: unknown } | null;
        if (json && json.shop === null) return { state: 'none' };
        const shop = readShop(json?.shop);
        return shop ? { state: 'open', shop } : { state: 'offline' };
    } catch {
        return { state: 'offline' };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

const UNREADABLE = () => new Error(t("Your shop couldn't be read just now. Try again."));

/**
 * Opens the member's shop if need be ({} opens it as it is), then changes what `changes` names.
 */
export async function changeMyShop(changes: MyShopChanges, options: { timeoutMs?: number } = {}): Promise<{ shop: MyShop; paused: number; resumed: number }> {
    const stop = options.timeoutMs ? new AbortController() : null;
    const timer = stop ? setTimeout(() => stop.abort(), options.timeoutMs) : null;
    try {
        const json = await request<{ shop: unknown; paused: unknown; resumed: unknown }>('PUT', '/api/shops/mine', changes, stop?.signal);
        const shop = readShop(json.shop);
        if (!shop) throw UNREADABLE();
        return { shop, paused: movedCount(json.paused), resumed: movedCount(json.resumed) };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Closes the member's shop: its Offers stay in the Market on their own, or end with `endOffers`. */
export async function closeMyShop(endOffers: boolean): Promise<{ cleared: number; ended: number; resumed: number }> {
    const json = await request<{ cleared: unknown; ended: unknown; resumed: unknown }>('POST', '/api/shops/mine/close', { endOffers });
    return { cleared: movedCount(json.cleared), ended: movedCount(json.ended), resumed: movedCount(json.resumed) };
}

/** "Add my live Offers": puts these in the member's shop, all or none; how many went in. */
export async function addOffersToMyShop(postIds: string[]): Promise<number> {
    const json = await request<{ added: unknown }>('POST', '/api/shops/mine/offers', { postIds });
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
    photo: string | null;
    featuredAt: string | null;
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
        featuredAt: typeof p.featuredAt === 'string' && p.featuredAt ? p.featuredAt : null,
    };
}

async function readListings(path: string): Promise<ShopListing[] | null> {
    try {
        const res = await signedFetch('GET', path);
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
 * The Offers "Add my live Offers" offers: the member's own that the node would take:
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

// ── words & display ─────────────────────────────────────────────────────────────────────────────

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
export function localDay(d: Date = new Date()): string {
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

/** What one of its Offers is doing now, in words. */
export function listingState(l: ShopListing): string {
    if (l.status === 'paused') return t('Paused');
    if (l.status === 'pending') return l.lendable ? t('Out on loan') : t('In a deal');
    return l.lendable ? t('To borrow') : t('On the Market');
}

/** A shop's category as it is shown: the emoji and the words its listings have for it. */
export function shopCategoryLabel(category: ShopCategory): string {
    return t('{emoji} {label}', { emoji: categoryEmoji(category), label: categoryLabel(category) });
}

// ── ShopToggle helper ───────────────────────────────────────────────────────────────────────────

export type ShopToggleState =
    | { kind: 'open'; shopId: string; title: string; inShop: boolean; category?: ShopCategory | null }
    | { kind: 'paused'; shopId: string; title: string; inShop: boolean; category?: ShopCategory | null }
    | { kind: 'none' }
    | { kind: 'hidden' };

export function shopToggleState(read: MyShopRead | null, opts: { inShop?: boolean } = {}): ShopToggleState {
    if (!read) return { kind: 'hidden' };
    if (read.state === 'none') return { kind: 'none' };
    if (read.state !== 'open') return { kind: 'hidden' };
    const base = { shopId: read.shop.id, title: shopTitle(read.shop), inShop: !!opts.inShop, category: read.shop.category };
    return read.shop.paused ? { kind: 'paused', ...base } : { kind: 'open', ...base };
}

export const shopTakesOffers = (state: ShopToggleState): boolean => state.kind === 'open' || state.kind === 'none';

export async function shopIdForEdit(state: ShopToggleState, startedOn: boolean, on: boolean): Promise<string | null | undefined> {
    if (on === startedOn) return undefined;
    if (!on) return null;
    if (state.kind === 'open') return state.shopId;
    if (state.kind === 'none') return (await changeMyShop({}, { timeoutMs: SHOP_COMPOSER_WAIT_MS })).shop.id;
    return undefined;
}

/** `/?shop=<id>` read once on load (like `takePostParam`). Cleans the parameter after reading. */
export function takeShopParam(win: Pick<Window, 'location' | 'history'> = window): string | null {
    const id = new URLSearchParams(win.location.search || '').get('shop');
    if (!id) return null;
    try {
        const params = new URLSearchParams(win.location.search);
        params.delete('shop');
        const qs = params.toString();
        win.history.replaceState(win.history.state, '', `${win.location.pathname}${qs ? `?${qs}` : ''}${win.location.hash || ''}`);
    } catch { /* the shop still opens */ }
    return id;
}
