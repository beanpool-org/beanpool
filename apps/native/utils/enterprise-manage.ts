/**
 * The keepers' Manage console on the phone (slice S7 of scratch/tools/DESIGN-shops-round3-enterprise-shopfront-fable.md
 * §3, §6; Marty's answers of 23 Oct 2026): app/treasury-manage.tsx, opened from Manage in the enterprise page's header.
 * Every keeper action the page had moved there, so the public page keeps no operator control. This is what the console
 * decides without the node:
 *
 * - Who may open it: a keeper of it (not suspended), or whoever the node says leads it or is a node admin
 *   (`isLeadOrSoleKeeperOrAdmin`), whose keeper requests and season controls they are.
 * - Its face as one form with one Save: any keeper its About, logo, category, how we deal and banner photo; the lead (its sole
 *   keeper, or a node admin) its name and purpose, which the others read with the sentence why. Only what changed is
 *   sent, each to its own route (the face to PUT /api/treasury/:t/profile, its category, how we deal and banner photo to its
 *   shop), the face first. A node admin who keeps none of it gets its name, purpose, About and logo only: its shop's
 *   routes take its keepers only (apps/server routes/shops.ts enterpriseOwner), so its category, how we deal and banner
 *   photo aren't theirs to change.
 * - Featured: its live Offers in its shop, six at most on the shelf (core SHOP_FEATURED_MAX), as the node counts them;
 *   and its live Offers not in its shop yet, which can't be featured until they are put in. Its keepers' only, as the
 *   feature and shop routes are.
 *
 * Not here: the tool shelves (the phone opens a tool as the member only), said in the PR that built this.
 */
import { SHOP_FEATURED_MAX, isShopCategory, t, type ShopCategory } from '@beanpool/core';
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

/** Its face as the form holds it: the words as typed, its category, and a new logo or banner photo once one is picked. */
export interface FaceForm {
    name: string;
    purpose: string;
    about: string;
    category: ShopCategory | null;
    howToDeal: string;
    /** A new picture (the phone's small copy), or null: its logo stays. */
    logo: string | null;
    /** Its banner: a new photo (the phone's 800 px copy), null to take it down; absent: it stays as its shop has it. */
    banner?: string | null;
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
        category: isShopCategory(shop.category) ? shop.category : null,
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
 * `lead` (the node refuses anyone else them); its category, how we deal and its banner photo only when `keeper` (its shop's
 * routes take its keepers only, never a node admin who keeps none of it); an empty How we deal clears it; a new logo goes
 * as the picture picked; a banner photo picked goes as the photo, and one taken down as none.
 */
export function faceSaveOf(before: FaceForm, draft: FaceForm, lead: boolean, keeper = true): FaceSave {
    const face: EnterpriseFaceChanges = {};
    const shop: MyShopChanges = {};
    const changed = (a: string, b: string) => a.trim() !== b.trim();
    if (lead && changed(draft.name, before.name)) face.name = draft.name.trim();
    if (lead && changed(draft.purpose, before.purpose)) face.purpose = draft.purpose.trim();
    if (changed(draft.about, before.about)) face.about = draft.about.trim();
    if (draft.logo) face.avatar = draft.logo;
    if (keeper && draft.category !== before.category) shop.category = draft.category;
    if (keeper && changed(draft.howToDeal, before.howToDeal)) shop.howToDeal = draft.howToDeal.trim() || null;
    if (keeper && draft.banner !== undefined) shop.photo = draft.banner;
    return { face, shop };
}

/** Whether a Save would send anything. */
export function savesAnything(save: FaceSave): boolean {
    return Object.keys(save.face).length > 0 || Object.keys(save.shop).length > 0;
}

/** The form as read and as typed, held together so a read and a Save each change both at once. */
export interface FaceState {
    before: FaceForm;
    draft: FaceForm;
}

const FACE_WORDS = ['name', 'purpose', 'about', 'category', 'howToDeal'] as const;

/**
 * The form when its enterprise is read again: the console reads it on every focus and after every action on it
 * (Featured, a keeper request, a season control), not only after this form's Save. Each field the keeper hasn't
 * changed since the last read takes the node's; what they typed or picked stays, still to be saved.
 */
export function faceOnRead(form: FaceState, read: FaceForm): FaceState {
    const draft = { ...form.draft };
    for (const k of FACE_WORDS) if (form.draft[k] === form.before[k]) (draft as Record<string, unknown>)[k] = read[k];
    return { before: read, draft };
}

/**
 * The form once `sent` was saved (`typed` the form as Save was pressed): what was sent is what the node holds now, and
 * each field of it the keeper hasn't changed since is that, so the next read takes the node's (faceOnRead). A logo or a
 * banner photo sent is the node's: the form holds no picture to send again. A field not sent stays as typed.
 */
export function faceAfterSave(form: FaceState, typed: FaceForm, sent: FaceSave): FaceState {
    const stored: Partial<FaceForm> = {};
    if (sent.face.name !== undefined) stored.name = sent.face.name;
    if (sent.face.purpose !== undefined) stored.purpose = sent.face.purpose;
    if (sent.face.about !== undefined) stored.about = sent.face.about;
    if (sent.shop.category !== undefined) stored.category = sent.shop.category;
    if (sent.shop.howToDeal !== undefined) stored.howToDeal = sent.shop.howToDeal ?? '';
    const draft = { ...form.draft };
    for (const k of FACE_WORDS) if (k in stored && form.draft[k] === typed[k]) (draft as Record<string, unknown>)[k] = stored[k];
    if (sent.face.avatar !== undefined && form.draft.logo === typed.logo) draft.logo = null;
    if (sent.shop.photo !== undefined && form.draft.banner === typed.banner) delete draft.banner;
    return { before: { ...form.before, ...stored }, draft };
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
