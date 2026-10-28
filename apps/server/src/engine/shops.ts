/**
 * Shops (slice S1 of scratch/tools/DESIGN-shops-and-tools-fable.md, §2.1, §4, §9.1, §9.4, §9.5; Marty's answers and
 * decision of 19 Oct 2026): a shop is a front window on an account, a member's or an enterprise's. It has a name, a
 * category, a blurb and "how I deal", and the Offers its owner puts in it (posts.shop_id). The same window moves from a
 * person to an enterprise unchanged when the till must split (slice S6); until then a member's shop is theirs, and all
 * its Beans are theirs.
 *
 * - One shop per account (openShop; not a unique index, which a standby's import would trip: schema.sql). A member opens
 *   theirs (routes/shops.ts PUT /api/shops/mine); an enterprise's is made with it (state-engine.ts createTreasury), and a
 *   keeper opens one for an enterprise made before.
 * - Its name: a member's own, or none, when the apps say "<the owner's name>'s shop" in the reader's language (the node
 *   keeps no words of its own for it). An enterprise's shop has no name of its own: its name is the enterprise's, read
 *   from members whenever it is read, so it follows every rename, on a standby too. Its blurb reads as the purpose until
 *   a keeper writes one.
 * - What goes in it (assertShopForPost): an Offer, for everyone here, of the shop's own account: a member's own Offer in
 *   their shop, an enterprise's (posted by a keeper through its own route) in the enterprise's. Never a Need, never an
 *   Offer for a group or one person (a shop shows what everyone here can see), never another account's shop.
 * - Pause ("Closed for now", optionally back on a day) and close (Marty, 19 Oct evening), neither while a deal on one of
 *   its things is asked for or open. Paused, its Offers on the board go off it (status 'paused', so every app and every
 *   copy takes them off, as a member's own pause does) and the shop keeps which ones; nothing goes in while it is, and
 *   none of them is put back up alone; reopened, those come back and an Offer its owner paused before stays paused. The
 *   owner's word wins meanwhile: one they pause, end or edit out of the shop while it is closed is theirs, and stays as
 *   they left it (forgetPausedPost).
 *   Closed, the row goes with a tombstone, and its Offers stay as ordinary Offers (the ones a pause took down back on the
 *   board) or end, as its owner picks. Closing an enterprise's shop winds up nothing.
 * - Read (routes/shops.ts): a member gets it whole, with counts of its listings as that member sees them; a visitor (the
 *   global profile's visitors' view) gets its category and counts only, since a name a member typed can name them (§4).
 * - Its category (Marty, 25 Oct 2026): one of the Market's (@beanpool/core SHOP_CATEGORIES), the list its listings pick
 *   from, or none. It picks the tools the apps show and where its new listings start (routes/marketplace.ts and the
 *   enterprise's offer route, newListingCategory), and gates nothing. An app from before categories sends a kind, one of
 *   the fourteen a shop had before: it is kept as the category it became (core SHOP_CATEGORY_KINDS), and that app reads
 *   no kind back (its shops show none) until it is updated.
 * - Featured (featureOffer; DESIGN-shops-round3-enterprise-shopfront-fable.md §0 row 7, §4, and Marty's answers of 23 Oct):
 *   up to six of its Offers, stamped on the listing (posts.featured_at), so every copy of the listing knows. Out of the
 *   shop, or the shop closed, the stamp goes.
 * - Its banner (round 3 §0 row 4; Marty, 24 Oct 2026): its one photo, set and taken down with its other words (changeShop
 *   `photo`), by whoever may change those: its owner, or any keeper of the enterprise. Kept as a group's picture is, out of
 *   its row (shop_photos, with its reference in shops.photo_ref, written together by setShopPhoto), under the photo rule
 *   (a JPEG, PNG, WebP or GIF, its metadata stripped, no more pixels than a node stores, at most 2 MB) and charged to the
 *   member who sends it (the day's photo budget). A member reads its URL, which carries its key; a visitor gets none. A
 *   close takes it with a tombstone of its own.
 *
 * A plain table (engine/replication-manifest.ts): a standby holds every shop verbatim, and a close reaches it as a
 * tombstone keyed by the shop's id. Every write here is the main server's: a standby refuses it (assertPlainTablesWritable,
 * and routes/standby-ledger-gate.ts before that). Every write stamps the row (db.ts stampPlainTables' triggers) and every
 * listing it changes (posts.updated_at), so a delta carries both.
 */
import crypto from 'node:crypto';
import {
    isShopCategory, shopCategoryOfKind, fitsTextLimit, replaceLoneSurrogates, textTooLongMessage, SHOP_NAME_LIMIT, SHOP_BLURB_LIMIT, SHOP_HOW_TO_DEAL_LIMIT,
    SHOP_BACK_ON_MAX_DAYS, SHOP_FEATURED_MAX, MAX_PICTURE_BYTES, avatarRefOf, shopOfPhotoUrl, shopPhotoUrlOf, word, type ShopCounts,
    type TextLimit,
} from '@beanpool/core';
import { avatarVersionByNode, getPosts, type MarketplacePost } from '@beanpool/engine';
import { db, writeTombstone } from '../db/db.js';
import { assertPlainTablesWritable } from '../config/node-role.js';
import { bumpPostsVersion } from './versions.js';
import { avatarValueRefusal, photoRefusalText } from './avatar.js';
import { assertMayStorePhotoBytes, incomingPhotoBytes, recordStoredPhotoBytes } from './photo-upload-budget.js';
import { stripImageValue } from '../storage/image-metadata.js';

/** A refusal meant for the member, in a sentence, with its status and code. */
export class ShopRefusal extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message);
        this.name = 'ShopRefusal';
    }
}

export const SHOP_OFFERS_ONLY = 'Only an Offer goes in a shop.';
export const SHOP_PUBLIC_ONLY = 'A shop shows what everyone here can see, so an Offer for a group or one person stays out of it.';
export const SHOP_NOT_YOURS = "That shop isn't yours, so nothing can go in it from here.";
export const SHOP_PAUSED_ADD = 'This shop is closed for now. Reopen it first, then put things in it.';
export const SHOP_PAUSED_RESUME = 'This is in a shop that is closed for now. Reopen the shop to put it back up.';
export const SHOP_NONE = 'There is no shop here to change. Open one first.';
export const SHOP_NAME_IS_ENTERPRISE = "An enterprise's shop has the enterprise's name, so it changes when the enterprise's name does.";
export const SHOP_CATEGORY_REFUSED = word('Pick one of the categories the app shows, or none.');
export const SHOP_NAME_NOT_TEXT = "A shop's name must be text.";
export const SHOP_BLURB_NOT_TEXT = 'What a shop is must be text.';
export const SHOP_HOW_TO_DEAL_NOT_TEXT = '"How I deal" must be text.';
export const SHOP_PAUSED_NOT_A_FLAG = 'paused must be true or false';
export const SHOP_BACK_ON_REFUSED = word(`A shop is back on a day from today to a year ahead, written YYYY-MM-DD.`);
export const SHOP_BACK_ON_OPEN = 'A shop says when it is back only while it is closed for now.';
export const SHOP_OFFERS_LIST_REFUSED = 'Send the Offers to put in the shop as postIds, a list of 1 to 200 listing ids.';
export const SHOP_OFFERS_NOT_YOURS = 'Only your own live Offers for everyone here go in your shop, and some of these are not.';
// The banner's refusals are marked with word('…') so the server's catalog (apps/server/words) holds them, as Featured's are.
export const SHOP_PHOTO_REFUSED = word("A shop's photo must be a JPEG, PNG, WebP or GIF picture.");
export const SHOP_PHOTO_TOO_LARGE = word('That photo is too large. Choose a smaller one.');

/** How many deals on a shop's things are open, said in the refusal. */
export function dealsOpenRefusal(n: number): ShopRefusal {
    return new ShopRefusal(409, 'shop_deals_open',
        `Finish or cancel the ${n} open deal${n === 1 ? '' : 's'} on this shop's things first.`);
}

/** The most Offers one "Add my live Offers" names. */
export const SHOP_OFFERS_BATCH_MAX = 200;

export interface ShopRow {
    id: string;
    owner_pubkey: string;
    name: string | null;
    /** One of the Market's categories (core SHOP_CATEGORIES), or null: none. */
    category: string | null;
    blurb: string | null;
    how_to_deal: string | null;
    opened_at: string;
    paused_at: string | null;
    back_on: string | null;
    paused_posts: string | null;
    updated_at: string;
    /** Its banner's reference (avatarRefOf), or null: none. The photo is in shop_photos. */
    photo_ref: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The account's shop, or null. */
export function shopOf(owner: string): ShopRow | null {
    return (db.prepare('SELECT * FROM shops WHERE owner_pubkey = ?').get(owner) as ShopRow | undefined) ?? null;
}

/** The shop with this id, or null (an id that is no text is none). */
export function shopById(id: unknown): ShopRow | null {
    if (typeof id !== 'string' || id === '') return null;
    return (db.prepare('SELECT * FROM shops WHERE id = ?').get(id) as ShopRow | undefined) ?? null;
}

/** Deals asked for or open (held in escrow) on the shop's listings: what a pause, a close and S6's step wait for. */
export function openDealsOn(shopId: string): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM marketplace_transactions mt JOIN posts p ON p.id = mt.post_id
                        WHERE p.shop_id = ? AND mt.status IN ('requested', 'pending')`).get(shopId) as { n: number }).n;
}

/**
 * The shop a new listing goes in, from what its maker sent (`shopId`): null when none was sent (undefined or null).
 * Refused, before anything is written: anything but an Offer (400 shop_offers_only), an Offer for a group or one person
 * (400 shop_public_only), a shop that isn't the author's own, isn't there, or an id that is no text (403 shop_not_yours,
 * one answer for all three, so the refusal tells nobody which shops there are), a shop that is closed for now (409
 * shop_paused). The author is the post's: a member, or the enterprise a keeper posts for.
 */
export function assertShopForPost(author: string, type: string, audienceScope: string | null | undefined, shopId: unknown): string | null {
    if (shopId === undefined || shopId === null) return null;
    if (type !== 'offer') throw new ShopRefusal(400, 'shop_offers_only', SHOP_OFFERS_ONLY);
    if ((audienceScope ?? 'public') !== 'public') throw new ShopRefusal(400, 'shop_public_only', SHOP_PUBLIC_ONLY);
    const shop = shopById(shopId);
    if (!shop || shop.owner_pubkey !== author) throw new ShopRefusal(403, 'shop_not_yours', SHOP_NOT_YOURS);
    if (shop.paused_at) throw new ShopRefusal(409, 'shop_paused', SHOP_PAUSED_ADD);
    return shop.id;
}

/**
 * An edit's shop: undefined when the edit leaves it as it is, else the id to store or null to take it out. Putting it in
 * is held to assertShopForPost; taking it out is always allowed (out of a paused shop too: it then stays paused as it
 * is, its own owner's to put back up, and the shop's reopen leaves it alone).
 */
export function shopOnEdit(post: { id: string; type: string; audienceScope?: string | null; authorPublicKey: string; shopId?: string }, shopId: unknown): string | null | undefined {
    if (shopId === undefined) return undefined;
    if (shopId === null) return null;
    if (shopId === post.shopId) return undefined;
    return assertShopForPost(post.authorPublicKey, post.type, post.audienceScope, shopId);
}

/**
 * The shop's pause (`from`) no longer holds this listing, so its reopen leaves it as it is: an edit took it out of the shop,
 * or its owner paused or ended it themselves (engine/posts.ts updatePost, pausePost, removePost). In the caller's
 * transaction; a shop that doesn't hold it is left unwritten.
 */
export function forgetPausedPost(from: string, postId: string): void {
    const shop = shopById(from);
    if (!shop?.paused_posts) return;
    const held = pausedPostsOf(shop);
    if (!held.includes(postId)) return;
    db.prepare('UPDATE shops SET paused_posts = ? WHERE id = ?').run(JSON.stringify(held.filter(id => id !== postId)), shop.id);
}

/** Refuses putting one of a paused shop's Offers back up alone (engine/posts.ts resumePost). */
export function assertShopOpenForResume(postId: string): void {
    const row = db.prepare('SELECT s.paused_at FROM posts p JOIN shops s ON s.id = p.shop_id WHERE p.id = ?').get(postId) as { paused_at: string | null } | undefined;
    if (row?.paused_at) throw new ShopRefusal(409, 'shop_paused', SHOP_PAUSED_RESUME);
}

function pausedPostsOf(shop: ShopRow): string[] {
    if (!shop.paused_posts) return [];
    try {
        const ids = JSON.parse(shop.paused_posts);
        return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
    } catch {
        return [];
    }
}

/** Opens `owner`'s shop if they have none, and returns it. In the caller's transaction when there is one. */
export function openShop(owner: string, now: number = Date.now()): ShopRow {
    assertPlainTablesWritable();
    return db.transaction((): ShopRow => {
        const held = shopOf(owner);
        if (held) return held;
        db.prepare('INSERT INTO shops (id, owner_pubkey, opened_at) VALUES (?, ?, ?)').run(crypto.randomUUID(), owner, iso(now));
        return shopOf(owner)!;
    })();
}

/** What a PUT may change. Every field is optional; null or empty text clears one. */
export interface ShopChanges {
    name?: unknown;
    /** One of the Market's categories, or null or empty text for none. */
    category?: unknown;
    /** An app from before categories: one of the fourteen kinds, kept as its category (core shopCategoryOfKind), or null. */
    kind?: unknown;
    blurb?: unknown;
    howToDeal?: unknown;
    paused?: unknown;
    backOn?: unknown;
    /** Its banner: a picture (a data URL), its own photo URL sent back (no change), or null or empty text to take it down. */
    photo?: unknown;
}

/** A text field as it will be stored: undefined to leave it, null to clear it, else the trimmed text. Refused if too long. */
function cleanText(raw: unknown, limit: TextLimit, what: string, notText: string): string | null | undefined {
    if (raw === undefined) return undefined;
    if (raw === null) return null;
    if (typeof raw !== 'string') throw new ShopRefusal(400, 'shop_text_refused', notText);
    const v = replaceLoneSurrogates(raw).trim();
    if (v === '') return null;
    if (!fitsTextLimit(v, limit)) throw new ShopRefusal(400, 'shop_text_refused', textTooLongMessage(what, limit));
    return v;
}

/**
 * A category as it will be stored: undefined to leave it, null to clear it (null or empty text), else one of the Market's
 * (core SHOP_CATEGORIES). `category` wins over `kind`, which an app from before categories sends: one of the fourteen kinds,
 * kept as the category it became (core shopCategoryOfKind). Refused, in a sentence: anything else.
 */
function cleanCategory(changes: ShopChanges): string | null | undefined {
    const fromKind = changes.category === undefined;
    const sent = fromKind ? changes.kind : changes.category;
    if (sent === undefined) return undefined;
    if (sent === null || sent === '') return null;
    const category = fromKind ? shopCategoryOfKind(sent) : isShopCategory(sent) ? sent : null;
    if (category === null) throw new ShopRefusal(400, 'shop_category_refused', SHOP_CATEGORY_REFUSED);
    return category;
}

/**
 * The category a new listing put in `shopId` starts in when it names none of its own (Marty, 25 Oct 2026): the shop's, or
 * null (no shop by that id, or one in no category); its author can change it like any listing's. Read before the post's
 * own checks refuse a shop that isn't the author's (assertShopForPost), which write nothing and answer no category.
 */
export function newListingCategory(shopId: unknown): string | null {
    return shopById(shopId)?.category ?? null;
}

/** How far the clocks furthest behind and ahead of UTC are (UTC−12, UTC+14). */
const CLOCKS_BEHIND_MS = 12 * 3_600_000;
const CLOCKS_AHEAD_MS = 14 * 3_600_000;

/**
 * A back-on day as stored: undefined to leave it, null to clear it, else YYYY-MM-DD from today to a year ahead. Today is
 * the member's, on a clock the node doesn't know: from the date where the clocks are furthest behind to a year after the
 * date where they are furthest ahead.
 */
function cleanBackOn(raw: unknown, now: number): string | null | undefined {
    if (raw === undefined) return undefined;
    if (raw === null || raw === '') return null;
    if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new ShopRefusal(400, 'shop_back_on_refused', SHOP_BACK_ON_REFUSED);
    const day = Date.parse(`${raw}T00:00:00.000Z`);
    const first = Date.parse(`${iso(now - CLOCKS_BEHIND_MS).slice(0, 10)}T00:00:00.000Z`);
    const last = Date.parse(`${iso(now + CLOCKS_AHEAD_MS).slice(0, 10)}T00:00:00.000Z`) + SHOP_BACK_ON_MAX_DAYS * 86_400_000;
    if (!Number.isFinite(day) || iso(day).slice(0, 10) !== raw || day < first || day > last) {
        throw new ShopRefusal(400, 'shop_back_on_refused', SHOP_BACK_ON_REFUSED);
    }
    return raw;
}

/**
 * A banner as it will be stored: undefined to leave it (none sent, or this shop's own photo URL sent back, which is the
 * photo it has), null to take it down (null or empty text), else the picture with its metadata stripped and the image bytes
 * it charges. Refused, in a sentence: anything that is no JPEG, PNG, WebP or GIF data URL the photo rule lets a node store
 * (someone's URL, another shop's photo URL, a shipped picture's name, a face's URL, text: 400 photo_refused), one with more
 * pixels than a node stores (400 photo_refused, the pixel rule's words), and one past MAX_PICTURE_BYTES (413
 * photo_too_large).
 */
export function cleanShopPhoto(raw: unknown, shopId: string | undefined): { photo: string; bytes: number } | null | undefined {
    if (raw === undefined) return undefined;
    if (raw === null) return null;
    if (typeof raw !== 'string') throw new ShopRefusal(400, 'photo_refused', SHOP_PHOTO_REFUSED);
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const named = shopOfPhotoUrl(trimmed);
    if (named !== null) {
        if (shopId !== undefined && named === shopId) return undefined;
        throw new ShopRefusal(400, 'photo_refused', SHOP_PHOTO_REFUSED);
    }
    if (!/^data:/i.test(trimmed)) throw new ShopRefusal(400, 'photo_refused', SHOP_PHOTO_REFUSED);
    const refusal = avatarValueRefusal(trimmed);
    if (refusal) throw new ShopRefusal(400, 'photo_refused', photoRefusalText(refusal, SHOP_PHOTO_REFUSED));
    const bytes = incomingPhotoBytes(trimmed);
    if (bytes > MAX_PICTURE_BYTES) throw new ShopRefusal(413, 'photo_too_large', SHOP_PHOTO_TOO_LARGE);
    return { photo: stripImageValue(trimmed), bytes };
}

/**
 * Sets a shop's banner to `photo`, or takes it down (null): its shop_photos row and the shop row's photo_ref, together.
 * The ONE writer of a shop's photo, so the reference always names the photo held. Taking one down, and a close, deletes
 * its row with a tombstone keyed by the shop's id, so a standby's delta carries it. In the caller's transaction. Returns
 * whether anything changed.
 */
export function setShopPhoto(shopId: string, photo: string | null): boolean {
    const ref = photo === null ? null : avatarRefOf(photo, avatarVersionByNode);
    if (ref === null) {
        const gone = db.prepare('DELETE FROM shop_photos WHERE shop_id = ?').run(shopId).changes > 0;
        if (gone) writeTombstone('shop_photos', shopId);
        const unref = db.prepare('UPDATE shops SET photo_ref = NULL WHERE id = ? AND photo_ref IS NOT NULL').run(shopId).changes > 0;
        return gone || unref;
    }
    const held = db.prepare('SELECT photo FROM shop_photos WHERE shop_id = ?').get(shopId) as { photo: string } | undefined;
    if (held?.photo === photo && (shopById(shopId)?.photo_ref ?? null) === ref) return false;
    db.prepare(`INSERT INTO shop_photos (shop_id, photo) VALUES (?, ?)
                ON CONFLICT(shop_id) DO UPDATE SET photo = excluded.photo`).run(shopId, photo);
    db.prepare('UPDATE shops SET photo_ref = ? WHERE id = ?').run(ref, shopId);
    return true;
}

/** What a change did to the shop's listings, for the route to tell the apps. */
export interface ShopListingsMoved {
    /** Offers a pause took off the board. */
    paused: string[];
    /** Offers a reopen, or a close of a paused shop, put back on it. */
    resumed: string[];
}

/**
 * Opens `owner`'s shop if need be and changes what the PUT names (ShopChanges), all of it or nothing. `enterprise`: the
 * owner is an enterprise, whose shop has the enterprise's name (a name sent is refused). `actor`: who sends it, the owner
 * unless a keeper writes for an enterprise, charged for a new banner (the day's photo budget). Pausing and reopening move
 * its Offers (see the file's head). Refused, before anything is written: a text over its limit or not text, a category
 * that is none of the Market's (an old app's kind none of the fourteen), a back-on day that is not one, a banner the
 * photo rule refuses (cleanShopPhoto) or past the actor's day of photos (429), a back-on day for a shop that stays open, a
 * pause while a deal is open.
 */
export function changeShop(owner: string, changes: ShopChanges, opts: { enterprise: boolean; actor?: string }, now: number = Date.now()): { shop: ShopRow } & ShopListingsMoved {
    assertPlainTablesWritable();
    if (opts.enterprise && changes.name !== undefined && changes.name !== null) {
        throw new ShopRefusal(400, 'shop_name_is_enterprise', SHOP_NAME_IS_ENTERPRISE);
    }
    const name = cleanText(changes.name, SHOP_NAME_LIMIT, "A shop's name", SHOP_NAME_NOT_TEXT);
    const blurb = cleanText(changes.blurb, SHOP_BLURB_LIMIT, 'What a shop is', SHOP_BLURB_NOT_TEXT);
    const howToDeal = cleanText(changes.howToDeal, SHOP_HOW_TO_DEAL_LIMIT, '"How I deal"', SHOP_HOW_TO_DEAL_NOT_TEXT);
    const category = cleanCategory(changes);
    if (changes.paused !== undefined && typeof changes.paused !== 'boolean') throw new ShopRefusal(400, 'shop_paused_refused', SHOP_PAUSED_NOT_A_FLAG);
    const backOn = cleanBackOn(changes.backOn, now);
    const photo = cleanShopPhoto(changes.photo, shopOf(owner)?.id);
    const actor = opts.actor ?? owner;
    if (photo && photo.bytes > 0) assertMayStorePhotoBytes(actor, photo.bytes, now);
    const nowIso = iso(now);
    const moved: ShopListingsMoved = { paused: [], resumed: [] };
    let photoMoved = false;

    const shop = db.transaction((): ShopRow => {
        const before = openShop(owner, now);
        const willBePaused = changes.paused === undefined ? !!before.paused_at : changes.paused;
        if (backOn && !willBePaused) throw new ShopRefusal(400, 'shop_back_on_open', SHOP_BACK_ON_OPEN);

        const sets: string[] = [];
        const values: unknown[] = [];
        if (name !== undefined) { sets.push('name = ?'); values.push(name); }
        if (category !== undefined) { sets.push('category = ?'); values.push(category); }
        if (blurb !== undefined) { sets.push('blurb = ?'); values.push(blurb); }
        if (howToDeal !== undefined) { sets.push('how_to_deal = ?'); values.push(howToDeal); }

        if (willBePaused && !before.paused_at) {
            const open = openDealsOn(before.id);
            if (open > 0) throw dealsOpenRefusal(open);
            moved.paused = (db.prepare(`SELECT id FROM posts WHERE shop_id = ? AND active = 1 AND status = 'active' ORDER BY id`)
                .all(before.id) as { id: string }[]).map(r => r.id);
            const take = db.prepare(`UPDATE posts SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'active'`);
            for (const id of moved.paused) take.run(nowIso, id);
            sets.push('paused_at = ?', 'back_on = ?', 'paused_posts = ?');
            values.push(nowIso, backOn ?? null, JSON.stringify(moved.paused));
        } else if (willBePaused) {
            if (backOn !== undefined) { sets.push('back_on = ?'); values.push(backOn); }
        } else if (before.paused_at) {
            moved.resumed = putBackUp(before, nowIso);
            sets.push('paused_at = NULL', 'back_on = NULL', 'paused_posts = NULL');
        }
        if (sets.length > 0) db.prepare(`UPDATE shops SET ${sets.join(', ')} WHERE id = ?`).run(...values, before.id);
        if (photo !== undefined) photoMoved = setShopPhoto(before.id, photo?.photo ?? null);
        if (photoMoved && photo) recordStoredPhotoBytes(actor, photo.bytes, now);
        return shopById(before.id)!;
    })();
    // A banner set, replaced or taken down moves no listing, but an enterprise's listings carry its keyed URL (engine
    // posts.ts authorBannerUrl), and the old one opens nothing: the list's tag moves, so a copy held from before is not
    // confirmed with a 304.
    if (moved.paused.length + moved.resumed.length > 0 || photoMoved) bumpPostsVersion();
    return { shop, ...moved };
}

/** The Offers a shop's pause took down that are still down and still in it, put back on the board. In the caller's transaction. */
function putBackUp(shop: ShopRow, nowIso: string): string[] {
    const back = db.prepare(`UPDATE posts SET status = 'active', updated_at = ? WHERE id = ? AND shop_id = ? AND active = 1 AND status = 'paused'`);
    return pausedPostsOf(shop).filter(id => back.run(nowIso, id, shop.id).changes > 0);
}

/**
 * Closes `owner`'s shop: refused while a deal on one of its things is open (409), and when there is none (404). Its row
 * goes, with a tombstone keyed by its id, and its banner with one of its own; every listing that named it names it no more. Its live Offers stay as ordinary
 * Offers (those its pause took down back on the board), or, with `endOffers`, end as a removal ends them: taken off for
 * good, with any keeper's wage still owed on one cancelled (engine/posts.ts removePost's follow-ons; no deal is open).
 */
export function closeShop(owner: string, endOffers: boolean, now: number = Date.now()): { shopId: string; cleared: string[]; ended: string[] } & ShopListingsMoved {
    assertPlainTablesWritable();
    const nowIso = iso(now);
    let bannerGone = false;
    const out = db.transaction(() => {
        const shop = shopOf(owner);
        if (!shop) throw new ShopRefusal(404, 'shop_not_found', SHOP_NONE);
        const open = openDealsOn(shop.id);
        if (open > 0) throw dealsOpenRefusal(open);
        const resumed = !endOffers && shop.paused_at ? putBackUp(shop, nowIso) : [];
        const named = (db.prepare('SELECT id FROM posts WHERE shop_id = ? ORDER BY id').all(shop.id) as { id: string }[]).map(r => r.id);
        let ended: string[] = [];
        if (endOffers) {
            ended = (db.prepare(`SELECT id FROM posts WHERE shop_id = ? AND active = 1 AND status IN ('active', 'paused') ORDER BY id`)
                .all(shop.id) as { id: string }[]).map(r => r.id);
            const end = db.prepare(`UPDATE posts SET active = 0, status = 'cancelled', updated_at = ? WHERE id = ?`);
            const wages = db.prepare(`UPDATE deferred_wage_claims SET status = 'cancelled' WHERE post_id = ? AND status = 'pending'`);
            for (const id of ended) { end.run(nowIso, id); wages.run(id); }
        }
        db.prepare('UPDATE posts SET shop_id = NULL, featured_at = NULL, updated_at = ? WHERE shop_id = ?').run(nowIso, shop.id);
        bannerGone = setShopPhoto(shop.id, null);
        db.prepare('DELETE FROM shops WHERE id = ?').run(shop.id);
        writeTombstone('shops', shop.id);
        return { shopId: shop.id, cleared: named, ended, paused: [] as string[], resumed };
    })();
    // The banner is read by the owner (engine posts.ts), so an enterprise's listings that were never in the shop lose it too.
    if (out.cleared.length > 0 || bannerGone) bumpPostsVersion();
    return out;
}

/**
 * "Add my live Offers" (Marty, 19 Oct evening): puts these listings in `owner`'s shop, all of them or none. Each must be
 * the owner's own live Offer (on the board, or out on loan or in a deal) for everyone here; anything else refuses the
 * whole list (400), as does a shop that is closed for now (409) or none (404). Returns the ids put in.
 */
export function addOffersToShop(owner: string, postIds: unknown, now: number = Date.now()): string[] {
    assertPlainTablesWritable();
    if (!Array.isArray(postIds) || postIds.length === 0 || postIds.length > SHOP_OFFERS_BATCH_MAX
        || postIds.some(id => typeof id !== 'string' || id === '' || id.length > 200)) {
        throw new ShopRefusal(400, 'shop_offers_refused', SHOP_OFFERS_LIST_REFUSED);
    }
    const ids = [...new Set(postIds as string[])];
    const nowIso = iso(now);
    const added = db.transaction((): string[] => {
        const shop = shopOf(owner);
        if (!shop) throw new ShopRefusal(404, 'shop_not_found', SHOP_NONE);
        if (shop.paused_at) throw new ShopRefusal(409, 'shop_paused', SHOP_PAUSED_ADD);
        const rows = db.prepare(`SELECT id FROM posts WHERE id IN (SELECT value FROM json_each(?))
                                 AND author_pubkey = ? AND type = 'offer' AND active = 1 AND status IN ('active', 'pending')
                                 AND COALESCE(audience_scope, 'public') = 'public' AND origin_node IS NULL`)
            .all(JSON.stringify(ids), owner) as { id: string }[];
        if (rows.length !== ids.length) throw new ShopRefusal(400, 'shop_offers_not_yours', SHOP_OFFERS_NOT_YOURS);
        const put = db.prepare('UPDATE posts SET shop_id = ?, updated_at = ? WHERE id = ? AND shop_id IS NOT ?');
        for (const id of ids) put.run(shop.id, nowIso, id, shop.id);
        return ids;
    })();
    bumpPostsVersion();
    return added;
}

/**
 * An account that is closed (a member's own deletion, an admin's removal: state-engine.ts purgeMemberSelf,
 * adminPruneUser) has no shop: its row and its banner go, each with a tombstone, and its listings name it no more. Inside the caller's
 * transaction. Returns the shop's id, or null when there was none.
 */
export function dropShopOf(owner: string, now: number = Date.now()): string | null {
    const shop = shopOf(owner);
    if (!shop) return null;
    db.prepare('UPDATE posts SET shop_id = NULL, featured_at = NULL, updated_at = ? WHERE shop_id = ?').run(iso(now), shop.id);
    setShopPhoto(shop.id, null);
    db.prepare('DELETE FROM shops WHERE id = ?').run(shop.id);
    writeTombstone('shops', shop.id);
    return shop.id;
}

// ── Featured ────────────────────────────────────────────────────────────────────────────────────

// Featured's refusals are marked with word('…') so the server's catalog (apps/server/words) holds them; a node writes them
// in English (core words.test N11). The flag's names the field, a developer's words, as SHOP_PAUSED_NOT_A_FLAG's.
export const FEATURE_NOT_YOURS = word("That listing isn't yours to feature.");
export const FEATURE_OFFERS_ONLY = word('Only an Offer can be featured in a shop.');
export const FEATURE_NOT_IN_SHOP = word('Put this Offer in the shop first, then feature it.');
export const FEATURE_ENDED = word("This Offer has ended, so it can't be featured.");
export const FEATURE_SHELF_FULL = word('Six is the shelf; un-feature one first.');
export const FEATURE_NOT_A_FLAG = 'featured must be true or false.';

export const ENTERPRISE_SHOP_CLOSED = word('This enterprise has been closed, so its shop can no longer be read or changed here.');
export const ENTERPRISE_SHOP_WOUND_UP = word('This enterprise has been wound up, so its shop can no longer be changed.');

/**
 * What an enterprise's status leaves of its shop, for its shop routes (routes/shops.ts) and Featured on its Offers: one
 * closed (pruned, disabled, suspended) has none to read or change, one wound up (completed) keeps its to read. The
 * refusal, 403 enterprise_closed, or undefined.
 */
export function enterpriseShopRefusal(status: string | null, op: 'read' | 'write'): ShopRefusal | undefined {
    if (status === 'pruned' || status === 'disabled' || status === 'suspended') return new ShopRefusal(403, 'enterprise_closed', ENTERPRISE_SHOP_CLOSED);
    if (op === 'write' && status === 'completed') return new ShopRefusal(403, 'enterprise_closed', ENTERPRISE_SHOP_WOUND_UP);
    return undefined;
}

/**
 * Which of a shop's Offers hold a place on its shelf: featured, and on the board or able to come back to it (live, out on
 * loan or in a deal, or paused). A pause takes one off the shopfront by its status and keeps its place, so a resume never
 * makes the shelf hold more than six; an ended one gives its place up.
 */
const SHELF_SQL = `SELECT COUNT(*) AS n FROM posts WHERE shop_id = ? AND id != ? AND featured_at IS NOT NULL
                   AND type = 'offer' AND active = 1 AND status IN ('active', 'pending', 'paused')`;

/**
 * Who may feature a listing, before anything else about it is said: its author, or a keeper of the enterprise that posted
 * it (canOperateTreasury, as its other routes). A listing that isn't there, an id that is no text, and one that isn't the
 * actor's are one refusal, so the answer says nothing of other members' listings (403 feature_not_yours).
 */
function featurableBy(postId: unknown, actor: string, mayKeep: (actor: string, enterprise: string) => boolean): FeaturePost {
    const post = typeof postId === 'string' && postId !== '' && postId.length <= 200
        ? db.prepare('SELECT p.id, p.type, p.shop_id, p.active, p.status, p.featured_at, p.author_pubkey, m.is_treasury, m.status AS author_status FROM posts p LEFT JOIN members m ON m.public_key = p.author_pubkey WHERE p.id = ?')
            .get(postId) as FeaturePost | undefined
        : undefined;
    const mine = !!post && (post.author_pubkey === actor || (post.is_treasury === 1 && mayKeep(actor, post.author_pubkey)));
    if (!post || !mine) throw new ShopRefusal(403, 'feature_not_yours', FEATURE_NOT_YOURS);
    return post;
}

interface FeaturePost {
    id: string;
    type: string;
    shop_id: string | null;
    active: number;
    status: string;
    featured_at: string | null;
    author_pubkey: string;
    is_treasury: number | null;
    author_status: string | null;
}

/**
 * Features an Offer in its shop, or takes it off the shelf (`featured` false), for its author or a keeper of the
 * enterprise that posted it (`mayKeep`). An enterprise's, either way, as its shop routes allow (enterpriseShopRefusal:
 * 403 enterprise_closed once it is closed or wound up), said only to its keepers: anyone else hears feature_not_yours
 * first. Featuring is refused,
 * writing nothing: on anything but an Offer (400
 * feature_offers_only), on one in no shop (400 feature_not_in_shop), on an ended one (400 feature_ended), and past the
 * shelf (409 feature_shelf_full: SHOP_FEATURED_MAX that hold a place, SHELF_SQL). `beforeFeature`: the caller's own check
 * of the listing's author once the listing is the actor's to feature, before it is written (a mute: featuring publishes;
 * taking one off doesn't). Featuring a featured one keeps its stamp; taking off one that isn't is nothing. Returns the
 * stamp now, or null, and whether anything was written; a write moves the listing's stamp and the listings' version, so
 * every app's next read and a standby's delta carry it.
 */
export function featureOffer(postId: unknown, actor: string, featured: unknown, mayKeep: (actor: string, enterprise: string) => boolean,
    beforeFeature: (author: string) => void = () => {}, now: number = Date.now()): { postId: string; featuredAt: string | null; changed: boolean } {
    if (typeof featured !== 'boolean') throw new ShopRefusal(400, 'feature_not_a_flag', FEATURE_NOT_A_FLAG);
    const done = db.transaction(() => {
        const post = featurableBy(postId, actor, mayKeep);
        // An enterprise's Offer, featured or taken off, is a change to its shop: as its shop routes say.
        const closed = post.is_treasury === 1 ? enterpriseShopRefusal(post.author_status, 'write') : undefined;
        if (closed) throw closed;
        if (!featured) {
            if (post.featured_at === null) return { postId: post.id, featuredAt: null, changed: false };
            db.prepare('UPDATE posts SET featured_at = NULL, updated_at = ? WHERE id = ?').run(iso(now), post.id);
            return { postId: post.id, featuredAt: null, changed: true };
        }
        if (post.type !== 'offer') throw new ShopRefusal(400, 'feature_offers_only', FEATURE_OFFERS_ONLY);
        if (!post.shop_id || !shopById(post.shop_id)) throw new ShopRefusal(400, 'feature_not_in_shop', FEATURE_NOT_IN_SHOP);
        if (post.active !== 1 || !['active', 'pending', 'paused'].includes(post.status)) throw new ShopRefusal(400, 'feature_ended', FEATURE_ENDED);
        beforeFeature(post.author_pubkey);
        if (post.featured_at !== null) return { postId: post.id, featuredAt: post.featured_at, changed: false };
        const onShelf = (db.prepare(SHELF_SQL).get(post.shop_id, post.id) as { n: number }).n;
        if (onShelf >= SHOP_FEATURED_MAX) throw new ShopRefusal(409, 'feature_shelf_full', FEATURE_SHELF_FULL);
        const at = iso(now);
        db.prepare('UPDATE posts SET featured_at = ?, updated_at = ? WHERE id = ?').run(at, at, post.id);
        return { postId: post.id, featuredAt: at, changed: true };
    })();
    if (done.changed) bumpPostsVersion();
    return done;
}

// ── Reading a shop ──────────────────────────────────────────────────────────────────────────────

const WEEK_MS = 7 * 86_400_000;

/**
 * A shop's listings as `reader` sees them, the shop's own read of the board (getPosts with `shopId`, as `shop=` on the
 * listings lists them): no more than the reader can see, and a visitor's (reader undefined) only what any visitor sees.
 * Read without the people in them (`guest`): a count needs none.
 */
export function shopListingsFor(shopId: string, reader: string | undefined): MarketplacePost[] {
    return getPosts(db, { shopId, type: 'offer', excludeEvents: true, viewerPubkey: reader, guest: true });
}

/** A shop's counts from its listings as a reader sees them (@beanpool/core ShopCounts). */
export function countsOf(posts: MarketplacePost[], now: number = Date.now()): ShopCounts {
    const live = posts.filter(p => p.status === 'active' || p.status === 'pending');
    const weekAgo = iso(now - WEEK_MS);
    return {
        things: live.length,
        available: live.filter(p => p.status === 'active').length,
        toBorrow: live.filter(p => p.lendable === true).length,
        toBuy: live.filter(p => p.lendable !== true).length,
        out: live.filter(p => p.status === 'pending' && p.lendable === true).length,
        newThisWeek: live.filter(p => (p.createdAt ?? '') >= weekAgo).length,
    };
}

/** A shop as a visitor gets it: its category and how much is in it, and nobody (§4, §9.4). */
export interface VisitorShop {
    id: string;
    category: string | null;
    counts: ShopCounts;
}

/** A shop as a member gets it. */
export interface MemberShop extends VisitorShop {
    /** Its own name; for an enterprise's, the enterprise's. Null: none chosen (the apps say "<ownerName>'s shop"). */
    name: string | null;
    ownerPublicKey: string;
    ownerName: string;
    /** Its owner is an enterprise. */
    enterprise: boolean;
    blurb: string | null;
    howToDeal: string | null;
    /** Closed for now, and the day it says it is back. */
    paused: boolean;
    backOn: string | null;
    openedAt: string;
    updatedAt: string;
    /** Its banner's URL, with its key (shopPhotoUrlOf), or null: none, and the apps draw a quiet block with its category's emoji. */
    photoUrl: string | null;
}

export function visitorShop(shop: ShopRow, now: number = Date.now()): VisitorShop {
    return { id: shop.id, category: shop.category, counts: countsOf(shopListingsFor(shop.id, undefined), now) };
}

export function memberShop(shop: ShopRow, reader: string | undefined, now: number = Date.now()): MemberShop {
    const owner = db.prepare('SELECT callsign, is_treasury, purpose FROM members WHERE public_key = ?').get(shop.owner_pubkey) as
        { callsign: string | null; is_treasury: number | null; purpose: string | null } | undefined;
    const enterprise = owner?.is_treasury === 1;
    const ownerName = owner?.callsign ?? '';
    return {
        id: shop.id,
        category: shop.category,
        counts: countsOf(shopListingsFor(shop.id, reader), now),
        name: enterprise ? ownerName : shop.name,
        ownerPublicKey: shop.owner_pubkey,
        ownerName,
        enterprise,
        blurb: shop.blurb ?? (enterprise && owner?.purpose ? owner.purpose : null),
        howToDeal: shop.how_to_deal,
        paused: !!shop.paused_at,
        backOn: shop.back_on,
        openedAt: shop.opened_at,
        updatedAt: shop.updated_at,
        photoUrl: shopPhotoUrlOf(shop.id, shop.photo_ref),
    };
}
