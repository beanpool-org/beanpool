/**
 * The keepers' Manage console on the phone (slice S7 of scratch/tools/DESIGN-shops-round3-enterprise-shopfront-fable.md
 * §3, §6; Marty's answers of 23 Oct 2026): app/treasury-manage.tsx, opened from Manage in the enterprise page's header.
 * Every keeper action the page had moved there, so the public page keeps no operator control. This is what the console
 * decides without the node:
 *
 * - Who may open it: a keeper of it (not suspended), or whoever the node says leads it or is a node admin
 *   (`isLeadOrSoleKeeperOrAdmin`), whose keeper requests and season controls they are.
 * - Its face as one form with one Save: any keeper its About, logo, kind and how we deal; the lead (its sole keeper, or a
 *   node admin) its name and purpose, which the others read with the sentence why. Only what changed is sent, each to
 *   its own route (the face to PUT /api/treasury/:t/profile, its kind and how we deal to its shop), the face first.
 * - Featured: its live Offers in its shop, six at most on the shelf (core SHOP_FEATURED_MAX), as the node counts them;
 *   and its live Offers not in its shop yet, which can't be featured until they are put in.
 *
 * Not here: the banner (the node keeps no photo for a shop yet) and the tool shelves (the phone opens a tool as the
 * member only): each is said in the PR that built this.
 */
import { SHOP_FEATURED_MAX, isShopKind, t, type ShopKind } from '@beanpool/core';
import { offersToAdd, type EnterpriseFaceChanges, type MyShopChanges, type ShopListing } from './shop';

/** Whether this reader may open the console: a keeper of it, or whom the node says leads it or administers the node. */
export function mayManage(detail: unknown, isKeeper: boolean): boolean {
    if (isKeeper) return true;
    return !!detail && typeof detail === 'object' && (detail as Record<string, unknown>).isLeadOrSoleKeeperOrAdmin === true;
}

/** Whether this reader may change its name and purpose: its lead, its sole keeper or a node admin, as the node says. */
export function leadsIt(detail: unknown): boolean {
    return !!detail && typeof detail === 'object' && (detail as Record<string, unknown>).isLeadOrSoleKeeperOrAdmin === true;
}

/** Why a keeper who doesn't lead it reads its name and purpose and can't change them: the node's own rule, said first. */
export function leadOnlyLine(project: boolean): string {
    return project
        ? t("Only the leader can change the project's name or what it is for.")
        : t("Only the lead keeper can change the enterprise's name or what it is for.");
}

/** What the console says to someone who opens it and keeps none of it. */
export function notKeeperLine(project: boolean): string {
    return project ? t('Only its collaborators manage this project.') : t('Only its keepers manage this enterprise.');
}

/** Its face as the form holds it: the words as typed, its kind, and a new logo once one is picked. */
export interface FaceForm {
    name: string;
    purpose: string;
    about: string;
    kind: ShopKind | null;
    howToDeal: string;
    /** A new picture (the phone's small copy), or null: its logo stays. */
    logo: string | null;
}

const words = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The form as the enterprise's detail has it now (GET /api/treasury/:t, its `shop` a member's view of it). */
export function faceFormOf(detail: unknown): FaceForm {
    const d = (detail && typeof detail === 'object' ? detail : {}) as Record<string, unknown>;
    const shop = (d.shop && typeof d.shop === 'object' ? d.shop : {}) as Record<string, unknown>;
    return {
        name: words(d.name),
        purpose: words(d.purpose),
        about: words(d.about),
        kind: isShopKind(shop.kind) ? shop.kind : null,
        howToDeal: words(shop.howToDeal),
        logo: null,
    };
}

/** What one Save sends: its face's changes and its shop's, each only what changed; empty when nothing did. */
export interface FaceSave {
    face: EnterpriseFaceChanges;
    shop: MyShopChanges;
}

/**
 * What changed between the form as read and as typed, trimmed as the node stores it. Its name and purpose only when
 * `lead` (the node refuses anyone else them); an empty How we deal clears it; a new logo goes as the picture picked.
 */
export function faceSaveOf(before: FaceForm, draft: FaceForm, lead: boolean): FaceSave {
    const face: EnterpriseFaceChanges = {};
    const shop: MyShopChanges = {};
    const changed = (a: string, b: string) => a.trim() !== b.trim();
    if (lead && changed(draft.name, before.name)) face.name = draft.name.trim();
    if (lead && changed(draft.purpose, before.purpose)) face.purpose = draft.purpose.trim();
    if (changed(draft.about, before.about)) face.about = draft.about.trim();
    if (draft.logo) face.avatar = draft.logo;
    if (draft.kind !== before.kind) shop.kind = draft.kind;
    if (changed(draft.howToDeal, before.howToDeal)) shop.howToDeal = draft.howToDeal.trim() || null;
    return { face, shop };
}

/** Whether a Save would send anything. */
export function savesAnything(save: FaceSave): boolean {
    return Object.keys(save.face).length > 0 || Object.keys(save.shop).length > 0;
}

/** The shelf as the console draws it. */
export interface FeaturedShelf {
    /** Its Offers in its shop that may hold a place: live, out on loan or in a deal, or paused. */
    inShop: ShopListing[];
    /** How many of them are on the shelf now. */
    featured: number;
    /** Six are: another can't go on until one comes off. */
    full: boolean;
    /** Its live Offers for everyone here that aren't in its shop yet (what "put them in its shop" sends). */
    outside: ShopListing[];
}

const HOLDS_A_PLACE = new Set(['active', 'pending', 'paused']);

/** Its Offers on and off the shelf, as the node counts the shelf (engine/shops.ts SHELF_SQL); none without a shop. */
export function featuredShelf(offers: readonly ShopListing[], shopId: string | null): FeaturedShelf {
    if (!shopId) return { inShop: [], featured: 0, full: false, outside: [] };
    const inShop = offers.filter((o) => o.shopId === shopId && HOLDS_A_PLACE.has(o.status));
    const featured = inShop.filter((o) => !!o.featuredAt).length;
    return { inShop, featured, full: featured >= SHOP_FEATURED_MAX, outside: offersToAdd(offers, shopId) };
}

/**
 * A refusal as the console shows it: the node's own sentence when it answered, else that the community couldn't be
 * reached. An answer without the node's words (`unsaid`: a proxy's page, an empty 500) is no answer.
 */
export function refusalWords(e: unknown): string {
    const err = e as { message?: unknown; status?: unknown; unsaid?: unknown } | null;
    const answered = typeof err?.status === 'number' && err.unsaid !== true && typeof err.message === 'string' && err.message.trim().length > 0;
    return answered ? String(err!.message) : t("Your community couldn't be reached. Try again.");
}
