/**
 * The List sheet's "Put this in your shop" (scratch/tools/DESIGN-tool-template-fable.md §1.5, slice S4′), carried to the
 * Offer the map's composer posts. The sheet hands its draft to the composer (tools/doors.ts), which is map.tsx's: it saves
 * its own fields as the member types and never carries one it doesn't know, posts with a fresh id, and map.tsx is not
 * edited for this. So the choice rides beside the draft, under its own key, and the one call the composer makes to post
 * (utils/db.ts createPost) reads it there.
 *
 * Nothing the member can't change reaches createPost, so the choice knows its Offer by what the sheet handed the
 * composer: the tool's title, its words, and its photos (a key for each, the composer carrying them as they were). An
 * edit keeps the choice while any one of those is still there, so a changed title is still its Offer. It holds for one
 * Offer, in the community the sheet was opened in, for everyone here (a shop shows what everyone can see), and for a day.
 *
 * An Offer the composer posts here while the choice waits, that it doesn't know as its own (changed past knowing, or
 * another Offer after "Start fresh"), or its own past the day, goes up outside the shop, and the member is told so once it
 * is up ({@link sayOutsideShop}), never left to find out; the choice is then forgotten, since the composer's one draft
 * has gone with that post. In the shop, createPost forgets it too. No network here, so utils/db.ts can import it.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { t } from '@beanpool/core';
import { showAppAlert } from './app-alert';

export const SHOP_CHOICE_KEY = 'beanpool_offer_shop_choice';
/** How long the choice waits for its Offer: a member may leave the composer to set a profile photo and come back. */
export const SHOP_CHOICE_HOLDS_MS = 24 * 60 * 60 * 1000;
/**
 * How long createPost waits for the member's shop (read, and opened if they have none) before it gives up and keeps the
 * draft: as long as the post itself waits. Without it, a link that takes the request and never answers (a captive portal,
 * a stalled 2G line) holds the composer's Post greyed, with no word, until the phone's network stack gives up. The Offer
 * edit's Save waits no longer for the shop it opens first (components/shop/ShopToggle.tsx shopIdForEdit).
 */
export const SHOP_COMPOSER_WAIT_MS = 10_000;

export interface ShopChoice {
    anchorUrl: string | null;
    title: string;
    /** The tool's words as the composer got them ('' for none), and a key for each of its photos ({@link photoKey}). */
    words?: string;
    photos?: string[];
    savedAt: number;
}

/** What the sheet handed the composer: the tool's title, its words and its photos (data URIs, as the draft holds them). */
export interface ShopChoiceOffer {
    title: string;
    description?: string;
    photos?: readonly string[];
}

/** What the composer is posting, as far as the choice goes (createPost's argument). */
export interface ComposerPost {
    type?: unknown;
    title?: unknown;
    description?: unknown;
    /** map.tsx sends its photos as a JSON list (or null). */
    photos?: unknown;
    audienceScope?: unknown;
    audience_scope?: unknown;
    targetGroupId?: unknown;
    target_group_id?: unknown;
    targetPubkey?: unknown;
    target_pubkey?: unknown;
}

const plain = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const sameText = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && !!plain(a) && plain(a) === plain(b);

/** A photo's key: its length and a 32-bit FNV-1a of it. A data URI is ~100 kB, so the choice keeps this, never the photo. */
function photoKey(uri: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < uri.length; i++) {
        h ^= uri.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return `${uri.length}.${(h >>> 0).toString(36)}`;
}

function postedPhotos(photos: unknown): string[] {
    let list = photos;
    if (typeof photos === 'string') {
        try { list = JSON.parse(photos); } catch { return []; }
    }
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : [];
}

/** Whether this is the Offer the sheet handed the composer: its title, its words or one of its photos is still there. */
function isItsOffer(c: Partial<ShopChoice>, post: ComposerPost): boolean {
    if (sameText(post.title, c.title) || sameText(post.description, c.words)) return true;
    const keys = new Set(Array.isArray(c.photos) ? c.photos : []);
    return keys.size > 0 && postedPhotos(post.photos).some((p) => keys.has(photoKey(p)));
}

/**
 * What a choice the sheet left means for this post, from this community at `now`:
 * - `shop`: it is the choice's Offer, for everyone, within the day: it goes in the member's shop
 * - `say`: an Offer for everyone here goes up outside the shop while the choice waited (one it doesn't know as its own),
 *   or its own Offer past the day: the member is told, and the choice forgotten
 * - `none`: nothing to do or say: no choice, another community's, a Need, a group's or one person's Offer (another form
 *   posts those, never the sheet's composer), or a choice past its day and an Offer that isn't its own
 */
export function shopChoiceFor(choice: unknown, post: ComposerPost, anchorUrl: string | null, now: number): 'shop' | 'say' | 'none' {
    if (!choice || typeof choice !== 'object') return 'none';
    const c = choice as Partial<ShopChoice>;
    if (typeof c.title !== 'string' || !c.title.trim() || typeof c.savedAt !== 'number' || !Number.isFinite(c.savedAt)) return 'none';
    if ((c.anchorUrl ?? null) !== (anchorUrl ?? null) || post.type !== 'offer') return 'none';
    const scope = post.audienceScope ?? post.audience_scope;
    if (scope !== undefined && scope !== null && scope !== 'public') return 'none';
    if (post.targetGroupId || post.target_group_id || post.targetPubkey || post.target_pubkey) return 'none';
    const waiting = now >= c.savedAt && now - c.savedAt <= SHOP_CHOICE_HOLDS_MS;
    const its = isItsOffer(c, post);
    if (its && waiting) return 'shop';
    return its || waiting ? 'say' : 'none';
}

/** The sheet's choice, kept for the Offer it handed the composer (on), or forgotten (off). */
export async function rememberShopChoice(anchorUrl: string | null, offer: ShopChoiceOffer, inShop: boolean, now: number = Date.now()): Promise<void> {
    try {
        if (!inShop) { await AsyncStorage.removeItem(SHOP_CHOICE_KEY); return; }
        const kept: ShopChoice = { anchorUrl, title: offer.title, words: offer.description ?? '', photos: (offer.photos ?? []).map(photoKey), savedAt: now };
        await AsyncStorage.setItem(SHOP_CHOICE_KEY, JSON.stringify(kept));
    } catch { /* best-effort, as the composer's own draft is */ }
}

/** The choice as kept, or null. */
export async function peekShopChoice(): Promise<ShopChoice | null> {
    try {
        const raw = await AsyncStorage.getItem(SHOP_CHOICE_KEY);
        return raw ? JSON.parse(raw) as ShopChoice : null;
    } catch {
        return null;
    }
}

export async function clearShopChoice(): Promise<void> {
    try { await AsyncStorage.removeItem(SHOP_CHOICE_KEY); } catch { /* nothing to forget */ }
}

/** Tells the member an Offer is up outside their shop while the List sheet's choice waited for it, and how to put it in. */
export function sayOutsideShop(title: string): void {
    showAppAlert(
        t('Not in your shop'),
        t('“{title}” is up, but not in your shop. To put it in, open it, tap Edit Post and tick Put this in your shop.', { title }, 'after an Offer is posted; Edit Post and Put this in your shop are the names of a button and a checkbox'),
    );
}
