/**
 * Shops (slice S1 of scratch/tools/DESIGN-shops-and-tools-fable.md, §2.1, §4, §9.1, §9.4, §9.5; Marty's answers and
 * decision of 19 Oct 2026): a shop is a front window on an account, a member's or an enterprise's. It has a name, a
 * kind, a blurb and "how I deal", and the Offers its owner puts in it (posts.shop_id). The same window moves from a
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
 *   none of them is put back up alone; reopened, those come back and an Offer its owner paused before stays paused.
 *   Closed, the row goes with a tombstone, and its Offers stay as ordinary Offers (the ones a pause took down back on the
 *   board) or end, as its owner picks. Closing an enterprise's shop winds up nothing.
 * - Read (routes/shops.ts): a member gets it whole, with counts of its listings as that member sees them; a visitor (the
 *   global profile's visitors' view) gets its kind and counts only, since a name a member typed can name them (§4).
 * - Featured (featureOffer; DESIGN-shops-round3-enterprise-shopfront-fable.md §0 row 7, §4, and Marty's answers of 23 Oct):
 *   up to six of its Offers, stamped on the listing (posts.featured_at), so every copy of the listing knows. Out of the
 *   shop, or the shop closed, the stamp goes.
 *
 * A plain table (engine/replication-manifest.ts): a standby holds every shop verbatim, and a close reaches it as a
 * tombstone keyed by the shop's id. Every write here is the main server's: a standby refuses it (assertPlainTablesWritable,
 * and routes/standby-ledger-gate.ts before that). Every write stamps the row (db.ts stampPlainTables' triggers) and every
 * listing it changes (posts.updated_at), so a delta carries both.
 */
import crypto from 'node:crypto';
import {
    isShopKind, fitsTextLimit, replaceLoneSurrogates, textTooLongMessage, SHOP_NAME_LIMIT, SHOP_BLURB_LIMIT, SHOP_HOW_TO_DEAL_LIMIT,
    SHOP_BACK_ON_MAX_DAYS, SHOP_FEATURED_MAX, type ShopCounts, type TextLimit,
} from '@beanpool/core';
import { getPosts, type MarketplacePost } from '@beanpool/engine';
import { db, writeTombstone } from '../db/db.js';
import { assertPlainTablesWritable } from '../config/node-role.js';
import { bumpPostsVersion } from './versions.js';

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
export const SHOP_KIND_REFUSED = 'Pick one of the kinds of shop the app shows, or none.';
export const SHOP_NAME_NOT_TEXT = "A shop's name must be text.";
export const SHOP_BLURB_NOT_TEXT = 'What a shop is must be text.';
export const SHOP_HOW_TO_DEAL_NOT_TEXT = '"How I deal" must be text.';
export const SHOP_PAUSED_NOT_A_FLAG = 'paused must be true or false';
export const SHOP_BACK_ON_REFUSED = `A shop is back on a day from today to a year ahead, written YYYY-MM-DD.`;
export const SHOP_BACK_ON_OPEN = 'A shop says when it is back only while it is closed for now.';
export const SHOP_OFFERS_LIST_REFUSED = 'Send the Offers to put in the shop as postIds, a list of 1 to 200 listing ids.';
export const SHOP_OFFERS_NOT_YOURS = 'Only your own live Offers for everyone here go in your shop, and some of these are not.';

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
    kind: string | null;
    blurb: string | null;
    how_to_deal: string | null;
    opened_at: string;
    paused_at: string | null;
    back_on: string | null;
    paused_posts: string | null;
    updated_at: string;
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

/** After an edit took a listing out of its shop (`from`), the shop's pause no longer holds it. In the edit's transaction. */
export function forgetPausedPost(from: string, postId: string): void {
    const shop = shopById(from);
    if (!shop?.paused_posts) return;
    const kept = pausedPostsOf(shop).filter(id => id !== postId);
    db.prepare('UPDATE shops SET paused_posts = ? WHERE id = ?').run(JSON.stringify(kept), shop.id);
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
    kind?: unknown;
    blurb?: unknown;
    howToDeal?: unknown;
    paused?: unknown;
    backOn?: unknown;
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

/** What a change did to the shop's listings, for the route to tell the apps. */
export interface ShopListingsMoved {
    /** Offers a pause took off the board. */
    paused: string[];
    /** Offers a reopen, or a close of a paused shop, put back on it. */
    resumed: string[];
}

/**
 * Opens `owner`'s shop if need be and changes what the PUT names (ShopChanges), all of it or nothing. `enterprise`: the
 * owner is an enterprise, whose shop has the enterprise's name (a name sent is refused). Pausing and reopening move its
 * Offers (see the file's head). Refused, before anything is written: a text over its limit or not text, a kind that is
 * none of the fourteen, a back-on day that is not one, a back-on day for a shop that stays open, a pause while a deal is
 * open.
 */
export function changeShop(owner: string, changes: ShopChanges, opts: { enterprise: boolean }, now: number = Date.now()): { shop: ShopRow } & ShopListingsMoved {
    assertPlainTablesWritable();
    if (opts.enterprise && changes.name !== undefined && changes.name !== null) {
        throw new ShopRefusal(400, 'shop_name_is_enterprise', SHOP_NAME_IS_ENTERPRISE);
    }
    const name = cleanText(changes.name, SHOP_NAME_LIMIT, "A shop's name", SHOP_NAME_NOT_TEXT);
    const blurb = cleanText(changes.blurb, SHOP_BLURB_LIMIT, 'What a shop is', SHOP_BLURB_NOT_TEXT);
    const howToDeal = cleanText(changes.howToDeal, SHOP_HOW_TO_DEAL_LIMIT, '"How I deal"', SHOP_HOW_TO_DEAL_NOT_TEXT);
    if (changes.kind !== undefined && changes.kind !== null && !isShopKind(changes.kind)) {
        throw new ShopRefusal(400, 'shop_kind_refused', SHOP_KIND_REFUSED);
    }
    if (changes.paused !== undefined && typeof changes.paused !== 'boolean') throw new ShopRefusal(400, 'shop_paused_refused', SHOP_PAUSED_NOT_A_FLAG);
    const backOn = cleanBackOn(changes.backOn, now);
    const nowIso = iso(now);
    const moved: ShopListingsMoved = { paused: [], resumed: [] };

    const shop = db.transaction((): ShopRow => {
        const before = openShop(owner, now);
        const willBePaused = changes.paused === undefined ? !!before.paused_at : changes.paused;
        if (backOn && !willBePaused) throw new ShopRefusal(400, 'shop_back_on_open', SHOP_BACK_ON_OPEN);

        const sets: string[] = [];
        const values: unknown[] = [];
        if (name !== undefined) { sets.push('name = ?'); values.push(name); }
        if (changes.kind !== undefined) { sets.push('kind = ?'); values.push(changes.kind); }
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
        return shopById(before.id)!;
    })();
    if (moved.paused.length + moved.resumed.length > 0) bumpPostsVersion();
    return { shop, ...moved };
}

/** The Offers a shop's pause took down that are still down and still in it, put back on the board. In the caller's transaction. */
function putBackUp(shop: ShopRow, nowIso: string): string[] {
    const back = db.prepare(`UPDATE posts SET status = 'active', updated_at = ? WHERE id = ? AND shop_id = ? AND active = 1 AND status = 'paused'`);
    return pausedPostsOf(shop).filter(id => back.run(nowIso, id, shop.id).changes > 0);
}

/**
 * Closes `owner`'s shop: refused while a deal on one of its things is open (409), and when there is none (404). Its row
 * goes, with a tombstone keyed by its id; every listing that named it names it no more. Its live Offers stay as ordinary
 * Offers (those its pause took down back on the board), or, with `endOffers`, end as a removal ends them: taken off for
 * good, with any keeper's wage still owed on one cancelled (engine/posts.ts removePost's follow-ons; no deal is open).
 */
export function closeShop(owner: string, endOffers: boolean, now: number = Date.now()): { shopId: string; cleared: string[]; ended: string[] } & ShopListingsMoved {
    assertPlainTablesWritable();
    const nowIso = iso(now);
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
        db.prepare('DELETE FROM shops WHERE id = ?').run(shop.id);
        writeTombstone('shops', shop.id);
        return { shopId: shop.id, cleared: named, ended, paused: [] as string[], resumed };
    })();
    if (out.cleared.length > 0) bumpPostsVersion();
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
 * adminPruneUser) has no shop: its row goes with a tombstone, and its listings name it no more. Inside the caller's
 * transaction. Returns the shop's id, or null when there was none.
 */
export function dropShopOf(owner: string, now: number = Date.now()): string | null {
    const shop = shopOf(owner);
    if (!shop) return null;
    db.prepare('UPDATE posts SET shop_id = NULL, featured_at = NULL, updated_at = ? WHERE shop_id = ?').run(iso(now), shop.id);
    db.prepare('DELETE FROM shops WHERE id = ?').run(shop.id);
    writeTombstone('shops', shop.id);
    return shop.id;
}

// ── Featured ────────────────────────────────────────────────────────────────────────────────────

export const FEATURE_NOT_YOURS = "That listing isn't yours to feature.";
export const FEATURE_OFFERS_ONLY = 'Only an Offer can be featured in a shop.';
export const FEATURE_NOT_IN_SHOP = 'Put this Offer in the shop first, then feature it.';
export const FEATURE_ENDED = "This Offer has ended, so it can't be featured.";
export const FEATURE_SHELF_FULL = 'Six is the shelf; un-feature one first.';
export const FEATURE_NOT_A_FLAG = 'featured must be true or false.';

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
        ? db.prepare('SELECT p.id, p.type, p.shop_id, p.active, p.status, p.featured_at, p.author_pubkey, m.is_treasury FROM posts p LEFT JOIN members m ON m.public_key = p.author_pubkey WHERE p.id = ?')
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
}

/**
 * Features an Offer in its shop, or takes it off the shelf (`featured` false), for its author or a keeper of the
 * enterprise that posted it (`mayKeep`). Featuring is refused, writing nothing: on anything but an Offer (400
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

/** A shop as a visitor gets it: what kind it is and how much is in it, and nobody (§4, §9.4). */
export interface VisitorShop {
    id: string;
    kind: string | null;
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
}

export function visitorShop(shop: ShopRow, now: number = Date.now()): VisitorShop {
    return { id: shop.id, kind: shop.kind, counts: countsOf(shopListingsFor(shop.id, undefined), now) };
}

export function memberShop(shop: ShopRow, reader: string | undefined, now: number = Date.now()): MemberShop {
    const owner = db.prepare('SELECT callsign, is_treasury, purpose FROM members WHERE public_key = ?').get(shop.owner_pubkey) as
        { callsign: string | null; is_treasury: number | null; purpose: string | null } | undefined;
    const enterprise = owner?.is_treasury === 1;
    const ownerName = owner?.callsign ?? '';
    return {
        id: shop.id,
        kind: shop.kind,
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
    };
}
