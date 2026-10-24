/**
 * The shops' routes (engine/shops.ts; slice S1 of scratch/tools/DESIGN-shops-and-tools-fable.md §9.1, with Marty's
 * additions of 19 Oct 2026: the Offer edit toggle, "Add my live Offers", pause and close).
 *
 *   GET  /api/shops?lat=&lng=&radiusKm=   → { shops: [shop + distanceKm] }   the shops near a place, nearest first
 *   GET  /api/shops/:id                   → shop                             one shop, 404 shop_not_found
 *   GET  /api/shops/mine                  → { shop: shop | null }            the signer's own
 *   PUT  /api/shops/mine { name?, kind?, blurb?, howToDeal?, paused?, backOn?, photo? }
 *                                         → { success, shop, paused, resumed }   opens it if need be, then changes it
 *   GET  /api/shops/:id/photo?v=&k=       → its banner's bytes, to a URL with its key; 404 for any other
 *   POST /api/shops/mine/close { endOffers? }
 *                                         → { success, shopId, cleared, ended, resumed }
 *   POST /api/shops/mine/offers { postIds }
 *                                         → { success, added }               "Add my live Offers"
 *
 * and the same for an enterprise's shop, by a keeper of it, with the enterprise as the owner:
 *
 *   GET | PUT /api/treasury/:treasury/shop, POST /api/treasury/:treasury/shop/close, POST /api/treasury/:treasury/shop/offers
 *
 * A shop's `photo` is its banner (DESIGN-shops-round3-enterprise-shopfront-fable.md §0 row 4; Marty, 24 Oct 2026): a
 * picture to put up or replace it, its own URL sent back to keep it, null to take it down (engine/shops.ts cleanShopPhoto),
 * charged to the signer who sends it, a keeper writing for an enterprise included.
 *
 * and one of a shop's Offers featured on its shelf, or taken off it (DESIGN-shops-round3-enterprise-shopfront-fable.md §4),
 * by its author or a keeper of the enterprise that posted it:
 *
 *   PUT  /api/marketplace/posts/:id/feature { featured }
 *                                         → { success, postId, featuredAt }   six at most (engine/shops.ts featureOffer)
 *
 * What goes in a shop is said when a listing is made or edited (routes/marketplace.ts, routes/treasury.ts: `shopId`), and
 * a shop's listings are read with `shop=` on GET /api/marketplace/posts.
 *
 * ## Who reads what
 *
 * A shop and the shops near a place are the listings' kind of read (https-server.ts PUBLIC_ONLY_ON_GUEST_LISTINGS_*): a
 * member's of this node on a local community, and on a node that shows visitors the listings and not the people
 * (`guestListingsOnly`, the global node) anyone's, in the visitors' view. A visitor gets each shop's id, kind and counts,
 * and in the near list a whole-km distance worked out from the listings' areas (the listings' own visitors' read,
 * getPosts `coarse`), never its name, owner, blurb or "how I deal": a name a member typed can name them (§4, §9.4). A
 * member gets it whole. Every count is of the shop's listings as that reader may see them (engine/shops.ts
 * shopListingsFor), so no answer says more than `shop=` would list. Its banner's URL is in a member's read alone, with the
 * key its photo route asks for (engine/avatar-keys.ts): an `<img>` cannot sign, so the route is a public read
 * (https-server.ts PUBLIC_READ_PATTERNS) that serves the bytes to that key and answers anything else as no photo.
 *
 * ## Only ever the owner's own
 *
 * No route takes the owner from the query or the body: a member is `ctx.state.actor`, verified by the real
 * `requireSignature` middleware, and an enterprise is the path's, which the signer must keep (canOperateTreasury, as for
 * its Offers). An enterprise closed (pruned, disabled, suspended) has no shop to change; one wound up keeps its to read.
 * A change that publishes (its words, its kind, a new banner, a reopen, Offers put in, a close that puts a pause's Offers
 * back up) is refused to a muted member or enterprise (G3); taking the banner down is not one.
 *
 * ## The main server only, for a change
 *
 * A standby answers the reads from its copy and refuses a change, 409 `standby`, before the handler runs
 * (routes/standby-ledger-gate.ts), and the engine refuses underneath. Each change is one of the signer's day of signed
 * writes, or the enterprise's when a keeper writes for it (the gateway's day budget).
 */
import Router from '@koa/router';
import { ONE_PASS_MAX_MEASURED, getPosts } from '@beanpool/engine';
import { passesReadGate, isNodeMember, canOperateTreasury, broadcast } from '../state-engine.js';
import { db } from '../db/db.js';
import { StandbyLedgerError } from '../config/node-role.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { NOT_A_MEMBER_CODE, NOT_A_MEMBER_ERROR } from '../engine/members.js';
import { assertNotMuted } from '../engine/auto-moderation.js';
import { syncPulseMarketplaceGate } from '../daily-pulse.js';
import {
    ShopRefusal, shopOf, shopById, changeShop, closeShop, addOffersToShop, memberShop, visitorShop, featureOffer,
    enterpriseShopRefusal, type ShopChanges, type ShopRow,
} from '../engine/shops.js';
import { getAvatarService } from '../engine/avatar.js';
import { shopPhotoKeyMatches } from '../engine/avatar-keys.js';
import { respondProfileRefusal } from './profile-feature-gate.js';
import { parseDistanceQuery } from './distance-query.js';
import { seesGuestView, VIEW_HEADER } from './viewer.js';
import type Koa from 'koa';
import type { RouteDeps } from './types.js';
import { shopOfPhotoUrl, word } from '@beanpool/core';

/** How far the shops near a place reach when the read names no radius: the landing card's 50 km. */
export const SHOPS_NEAR_KM_DEFAULT = 50;
/** The most shops one near read answers. */
export const SHOPS_NEAR_MAX = 30;

type Op = 'read' | 'write';
type Ctx = Koa.Context & { params: Record<string, string | undefined>; requestBody?: Record<string, unknown> };

function refuse(ctx: Ctx, status: number, error: string, code?: string): void {
    ctx.set('Cache-Control', 'private, no-store');
    ctx.status = status;
    ctx.body = code ? { error, code } : { error };
}

function answer(ctx: Ctx, body: unknown): void {
    ctx.set('Cache-Control', 'private, no-store');
    ctx.body = body;
}

/** An engine refusal, the standby's or a mute's, answered in its own words; false for anything else (rethrown). */
function answeredRefusal(ctx: Ctx, e: unknown): boolean {
    if (e instanceof ShopRefusal || e instanceof StandbyLedgerError) { refuse(ctx, e.status, e.message, e.code); return true; }
    return respondProfileRefusal(ctx, e);
}

/** The verified signer, or undefined once the refusal is written. */
function signer(ctx: Ctx): string | undefined {
    const actor = ctx.state.actor as string | undefined;
    if (!actor) refuse(ctx, 401, word('A signed request is required'));
    return actor;
}

interface Owner { key: string; enterprise: boolean; actor: string }

/** The member whose own shop this is, or undefined once the refusal is written. */
function ownOwner(ctx: Ctx, op: Op): Owner | undefined {
    const actor = signer(ctx);
    if (!actor) return undefined;
    if (op === 'read' ? !passesReadGate(actor) : !isNodeMember(actor)) {
        if (op === 'read') refuse(ctx, 403, word('Read access requires a member identity'));
        else refuse(ctx, 403, NOT_A_MEMBER_ERROR, NOT_A_MEMBER_CODE);
        return undefined;
    }
    return { key: actor, enterprise: false, actor };
}

/**
 * The enterprise whose shop this is, when the signer keeps it, or undefined once the refusal is written. Its order and
 * words are its Offers' and its tools' (routes/tools.ts): no such enterprise 404, someone who doesn't keep it 403, one
 * closed 403, one wound up read-only.
 */
function enterpriseOwner(ctx: Ctx, op: Op): Owner | undefined {
    const actor = signer(ctx);
    if (!actor) return undefined;
    const treasury = String(ctx.params.treasury ?? '');
    const row = db.prepare('SELECT status FROM members WHERE public_key = ? AND is_treasury = 1').get(treasury) as { status: string | null } | undefined;
    if (!row) { refuse(ctx, 404, word('Not a treasury')); return undefined; }
    if (!canOperateTreasury(actor, treasury)) { refuse(ctx, 403, word('You are not a keeper of this enterprise')); return undefined; }
    const closed = enterpriseShopRefusal(row.status, op);
    if (closed) { answeredRefusal(ctx, closed); return undefined; }
    return { key: treasury, enterprise: true, actor };
}

/** A change that publishes is refused to a muted signer, and to a muted enterprise (G3). */
function assertMayPublish(owner: Owner): void {
    assertNotMuted(owner.actor);
    if (owner.enterprise) assertNotMuted(owner.key);
}

/** Whether a PUT's `photo` puts a new picture up: text that is no photo URL sent back, and not empty (a take-down). */
function newPhoto(photo: unknown): boolean {
    return photo !== undefined && photo !== null && (typeof photo !== 'string' || (photo.trim() !== '' && shopOfPhotoUrl(photo) === null));
}

/** The apps hear each listing a shop's change moved, as a member's own pause or resume tells them. */
function tellListingsMoved(ids: string[]): void {
    for (const id of ids) broadcast({ type: 'post_updated', id });
    if (ids.length > 0) syncPulseMarketplaceGate();
}

/** Who is reading a shop: a visitor (undefined, the visitors' view) or the member reading it (their key). */
function readerOf(ctx: Ctx): { guest: boolean; reader: string | undefined } {
    const guest = seesGuestView(ctx);
    if (getProfileSwitches().guestListingsOnly) ctx.set(VIEW_HEADER, guest ? 'guest' : 'member');
    return { guest, reader: guest ? undefined : ctx.state.actor as string | undefined };
}

const shopFor = (shop: ShopRow, guest: boolean, reader: string | undefined) => guest ? visitorShop(shop) : memberShop(shop, reader);

/** The four handlers for one kind of owner: the member's own shop, or an enterprise's. */
function handlers(ownerOf: (ctx: Ctx, op: Op) => Owner | undefined) {
    return {
        get: async (ctx: Ctx) => {
            const owner = ownerOf(ctx, 'read');
            if (!owner) return;
            const shop = shopOf(owner.key);
            answer(ctx, { shop: shop ? memberShop(shop, owner.actor) : null });
        },
        put: async (ctx: Ctx) => {
            const owner = ownerOf(ctx, 'write');
            if (!owner) return;
            const body = (ctx.requestBody ?? {}) as ShopChanges;
            try {
                const publishes = body.name !== undefined || body.kind !== undefined || body.blurb !== undefined
                    || body.howToDeal !== undefined || body.paused === false || newPhoto(body.photo) || !shopOf(owner.key);
                if (publishes) assertMayPublish(owner);
                const done = changeShop(owner.key, body, { enterprise: owner.enterprise, actor: owner.actor });
                tellListingsMoved([...done.paused, ...done.resumed]);
                answer(ctx, { success: true, shop: memberShop(done.shop, owner.actor), paused: done.paused, resumed: done.resumed });
            } catch (e) {
                if (!answeredRefusal(ctx, e)) throw e;
            }
        },
        close: async (ctx: Ctx) => {
            const owner = ownerOf(ctx, 'write');
            if (!owner) return;
            try {
                const endOffers = ctx.requestBody?.endOffers === true;
                // Closing a paused shop puts the pause's Offers back up unless they end: a reopen, so it publishes.
                if (!endOffers && shopOf(owner.key)?.paused_at) assertMayPublish(owner);
                const done = closeShop(owner.key, endOffers);
                tellListingsMoved(done.cleared);
                answer(ctx, { success: true, shopId: done.shopId, cleared: done.cleared.length, ended: done.ended.length, resumed: done.resumed.length });
            } catch (e) {
                if (!answeredRefusal(ctx, e)) throw e;
            }
        },
        offers: async (ctx: Ctx) => {
            const owner = ownerOf(ctx, 'write');
            if (!owner) return;
            try {
                assertMayPublish(owner);
                const added = addOffersToShop(owner.key, ctx.requestBody?.postIds);
                tellListingsMoved(added);
                answer(ctx, { success: true, added });
            } catch (e) {
                if (!answeredRefusal(ctx, e)) throw e;
            }
        },
    };
}

/**
 * PUT /api/marketplace/posts/:id/feature { featured }: an Offer on its shop's shelf or off it, by a member of this node who
 * wrote it or keeps the enterprise that did (engine/shops.ts featureOffer, which refuses everyone else in one answer).
 * Featuring publishes, so a muted signer, or a muted enterprise, can't (G3); taking one off stays open to them. Either is
 * a change to an enterprise's shop, refused as its shop routes refuse one once it is closed or wound up. The apps
 * hear the listing changed as they hear a shop's pause.
 */
async function feature(ctx: Ctx): Promise<void> {
    const owner = ownOwner(ctx, 'write');
    if (!owner) return;
    try {
        const done = featureOffer(ctx.params.id, owner.actor, ctx.requestBody?.featured, canOperateTreasury, author => {
            assertNotMuted(owner.actor);
            if (author !== owner.actor) assertNotMuted(author);
        });
        if (done.changed) tellListingsMoved([done.postId]);
        answer(ctx, { success: true, postId: done.postId, featuredAt: done.featuredAt });
    } catch (e) {
        if (!answeredRefusal(ctx, e)) throw e;
    }
}

/**
 * GET /api/shops/:id/photo?v=&k=: a shop's banner, for an `<img>`, which cannot sign: a public read (https-server.ts
 * PUBLIC_READ_PATTERNS), served only to a URL carrying the key for this photo as it is now (engine/avatar-keys.ts), which
 * only a member's read of the shop hands out. Any other request, a shop with no photo included, is answered alike. The
 * bytes as a group's picture's are served (routes/groups.ts): raster only, under the type they are, never kept by a shared
 * cache.
 */
async function getShopPhoto(ctx: Ctx): Promise<void> {
    const shopId = String(ctx.params.id ?? '');
    if (!shopPhotoKeyMatches(shopId, ctx.query.k)) {
        ctx.status = 404;
        ctx.body = { error: 'Photo not found' };
        return;
    }
    const result = await getAvatarService().getShopPhoto(shopId, { ifNoneMatch: ctx.get('If-None-Match') });
    if (result.status === 304) {
        ctx.status = 304;
        if (result.etag) ctx.set('ETag', result.etag);
        ctx.set('Cache-Control', 'private, max-age=0, must-revalidate');
        return;
    }
    if (result.status !== 200 || !result.buffer) {
        ctx.status = result.status;
        ctx.body = { error: result.error || 'Photo not found' };
        return;
    }
    ctx.status = 200;
    ctx.type = result.contentType!;
    ctx.set('Content-Type', result.contentType!);
    ctx.set('X-Content-Type-Options', 'nosniff');
    ctx.set('Content-Disposition', 'inline');
    if (result.etag) ctx.set('ETag', result.etag);
    ctx.set('Cache-Control', 'private, max-age=0, must-revalidate');
    ctx.body = result.buffer;
}

/** GET /api/shops/:id: one shop, as this reader may see it. */
async function getShop(ctx: Ctx): Promise<void> {
    const { guest, reader } = readerOf(ctx);
    const shop = shopById(ctx.params.id);
    if (!shop) { refuse(ctx, 404, word('There is no such shop here.'), 'shop_not_found'); return; }
    answer(ctx, shopFor(shop, guest, reader));
}

/**
 * GET /api/shops?lat=&lng=&radiusKm=: the shops with a listing near the place, nearest first, each once, placed by its
 * nearest listing the reader may see. The listings are read as the listings' own read reads them for this reader (a
 * visitor's from each listing's area, `coarse`; a member of a node anyone can join from its neighbourhood), so a shop's
 * distance and place in the order are its nearest listing's in that read, and never finer. The read ranks shops, not
 * listings (getPosts `nearestPerShop`): one row per shop, so a shop with many listings near the place hides none past
 * it, and the answer is the nearest SHOPS_NEAR_MAX of every shop with a listing the one pass measures.
 */
async function getShopsNear(ctx: Ctx): Promise<void> {
    const distance = parseDistanceQuery(ctx.query);
    if (!distance.ok) { refuse(ctx, 400, distance.error); return; }
    const { point } = distance.value;
    if (!point) { refuse(ctx, 400, 'Shops near a place need the place: give lat and lng.'); return; }
    const radiusKm = distance.value.radiusKm ?? SHOPS_NEAR_KM_DEFAULT;
    const { guest, reader } = readerOf(ctx);
    const neighbourhood = !!reader && !guest && getProfileSwitches().openMembership;
    const near = getPosts(db, {
        type: 'offer', excludeEvents: true, inShop: true, viewerPubkey: reader, guest: true, coarse: guest || undefined,
        neighbourhood: neighbourhood || undefined, near: { ...point, radiusKm }, sortByDistance: true, nearestPerShop: true,
        measureAtMost: ONE_PASS_MAX_MEASURED, limit: SHOPS_NEAR_MAX,
    });
    const shops: unknown[] = [];
    for (const post of near) {
        const shop = post.shopId ? shopById(post.shopId) : undefined;
        if (!shop) continue;
        const km = post.distanceKm ?? 0;
        shops.push({ ...shopFor(shop, guest, reader), distanceKm: guest ? Math.round(km) : Math.round(km * 10) / 10 });
    }
    answer(ctx, { shops });
}

export function createShopRoutes(_deps: RouteDeps): Router {
    const router = new Router();
    const own = handlers(ownOwner);
    // The signer's own first: `mine` is no shop's id.
    router.get('/api/shops/mine', own.get);
    router.put('/api/shops/mine', own.put);
    router.post('/api/shops/mine/close', own.close);
    router.post('/api/shops/mine/offers', own.offers);
    router.get('/api/shops', getShopsNear);
    router.get('/api/shops/:id/photo', getShopPhoto);
    router.get('/api/shops/:id', getShop);
    const enterprise = handlers(enterpriseOwner);
    router.get('/api/treasury/:treasury/shop', enterprise.get);
    router.put('/api/treasury/:treasury/shop', enterprise.put);
    router.post('/api/treasury/:treasury/shop/close', enterprise.close);
    router.post('/api/treasury/:treasury/shop/offers', enterprise.offers);
    router.put('/api/marketplace/posts/:id/feature', feature);
    return router;
}
