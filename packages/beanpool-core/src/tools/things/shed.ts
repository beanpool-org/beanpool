/**
 * The Tool shed's screens' rules (scratch/tools/DESIGN-tool-template-fable.md §3.1, slices T1.2 and T1.3), shared by the
 * phone's half and the web's so both say and do the same: a thing's state and its one-line state, the list's filters,
 * every change a screen makes to the document, the List draft, and the loans view. Pure: the time and any new id come in
 * as arguments; nothing here reads the clock, the network or a store. Sentences are drawn through t()/tn() when a
 * function is called, never at module level.
 *
 * A thing's states (DESIGN-tool-library-fable.md §2.1): on the shelf (private) → in the shop (its Offer live) → out (on a
 * loan through BeanPool, or lent outside it) → back in the shop → taken out of the shop (its Offer paused, kept so listing
 * it again puts the same Offer back) → gone when it is deleted (taken out of the document: nothing of it is kept).
 */
import { formatDate, t, tn, wordn } from '../../words.js';
import { PRICING_CATEGORIES, normalizeCategory } from '../../pricing-catalog.js';
import { toolDocBytes } from '../check.js';
import type { ToolDealSummary, ToolOfferDraft } from '../host.js';
import type { ToolLine } from '../manifest.js';
import {
    THINGS_LEND_TERMS_CHARS,
    THINGS_NAME_CHARS,
    THINGS_OWNER_NOTE_CHARS,
    THINGS_REPLACEMENT_VALUE_CHARS,
    isLentTo,
    isLiveThing,
    type Thing,
    type ThingCondition,
    type ThingsDoc,
} from './doc.js';
import { LEND_MAX_DAYS_MAX } from './loans.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** At most `n` code points, as readThingsDoc counts them (an emoji is one). */
const clip = (s: string, n: number) => [...s].slice(0, n).join('');

// ── States ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where a thing is: on the shelf, taken out of the shop (its Offer paused), in the shop, asked for (someone asked to
 * borrow it, nothing agreed), out on a loan through BeanPool, or lent to someone outside it.
 */
export type ThingState = 'shelf' | 'taken-out' | 'listed' | 'asked' | 'out' | 'lent';

/** A deal still open: asked for and not yet answered, or agreed and the thing out. */
const isOpenDeal = (d: ToolDealSummary) => d.status === 'requested' || d.status === 'pending';

/**
 * Each post's open deal, by post id: an agreed one (the thing out) over one only asked for, and the later of two alike.
 * Deals that are done (completed, cancelled, rejected) are not in it.
 */
export function openDealsByPost(deals: readonly ToolDealSummary[] | null | undefined): Map<string, ToolDealSummary> {
    const out = new Map<string, ToolDealSummary>();
    for (const d of deals ?? []) {
        if (!d || typeof d.postId !== 'string' || !isOpenDeal(d)) continue;
        const was = out.get(d.postId);
        const rank = (x: ToolDealSummary) => (x.status === 'pending' ? 1 : 0);
        if (!was || rank(d) > rank(was) || (rank(d) === rank(was) && String(d.updatedAt) > String(was.updatedAt))) out.set(d.postId, d);
    }
    return out;
}

/**
 * A thing's open deal (openDealsByPost), on its Offer in the shop or on the one taken out of it: a taken-out thing's Offer
 * can be put back up without the Tool shed (its shop's reopen, the Market's own resume) and lent from there.
 */
function dealOf(thing: Thing, deals: ReadonlyMap<string, ToolDealSummary>): ToolDealSummary | undefined {
    const offer = typeof thing.postId === 'string' ? thing.postId : thing.pausedPostId;
    return typeof offer === 'string' ? deals.get(offer) : undefined;
}

/** A thing's state, from the document and the owner's open deals (openDealsByPost). */
export function thingState(thing: Thing, deals: ReadonlyMap<string, ToolDealSummary> = new Map()): ThingState {
    if (isLentTo(thing.lentTo)) return 'lent';
    const deal = dealOf(thing, deals);
    if (deal?.status === 'pending') return 'out';
    if (deal?.status === 'requested') return 'asked';
    if (typeof thing.postId === 'string') return 'listed';
    if (typeof thing.pausedPostId === 'string') return 'taken-out';
    return 'shelf';
}

/** The list's filter chips: All · In your shop · Out · On the shelf. */
export type ThingFilter = 'all' | 'shop' | 'out' | 'shelf';
export const THING_FILTERS: readonly ThingFilter[] = ['all', 'shop', 'out', 'shelf'];

/** Whether a thing in `state` shows under `filter`. */
export function thingInFilter(state: ThingState, filter: ThingFilter): boolean {
    switch (filter) {
        case 'all': return true;
        case 'shop': return state === 'listed' || state === 'asked';
        case 'out': return state === 'out' || state === 'lent';
        case 'shelf': return state === 'shelf' || state === 'taken-out';
    }
}

/** The things the member still has, newest first (the last added at the top), each one this build reads. */
export function shedThings(doc: ThingsDoc): Thing[] {
    return (doc.things ?? []).filter(isLiveThing).reverse();
}

/** One thing the member still has, by its id, or null (an id from an old link, a deleted thing). */
export function findThing(doc: ThingsDoc, id: string | null | undefined): Thing | null {
    if (!id) return null;
    return (doc.things ?? []).find((t): t is Thing => isLiveThing(t) && t.id === id) ?? null;
}

const day = (iso: string) => formatDate(new Date(iso), 'day-month');
const validTime = (iso: unknown): iso is string => typeof iso === 'string' && Number.isFinite(Date.parse(iso));

/**
 * A thing's state in one line, in the member's language: "On your shelf", "In your shop", "With Sam · back around 3 Nov".
 * The name a member gave the person they lent it to is theirs, shown as written inside the sentence.
 */
export function thingStateLine(thing: Thing, deals: ReadonlyMap<string, ToolDealSummary> = new Map(), now: number = Date.now()): string {
    switch (thingState(thing, deals)) {
        case 'lent': {
            const lent = thing.lentTo!;
            if (validTime(lent.backAround)) {
                return Date.parse(lent.backAround) < now
                    ? t('With {name} · was due back {date}', { name: lent.name, date: day(lent.backAround) })
                    : t('With {name} · back around {date}', { name: lent.name, date: day(lent.backAround) });
            }
            return validTime(lent.since) ? t('With {name} since {date}', { name: lent.name, date: day(lent.since) }) : t('With {name}', { name: lent.name });
        }
        case 'out': {
            const back = dealOf(thing, deals)?.backAround;
            if (validTime(back)) {
                return Date.parse(back) < now ? t('Out on a loan · was due back {date}', { date: day(back) }) : t('Out on a loan · back around {date}', { date: day(back) });
            }
            return t('Out on a loan');
        }
        case 'asked': return t('In your shop · someone asked to borrow it');
        case 'listed': return t('In your shop');
        case 'taken-out': return t('Taken out of your shop');
        case 'shelf': return t('On your shelf');
    }
}

/**
 * A thing's state in a row of a list (Your things, Loans): one short line, what matters first, so the date still shows
 * where a 320 dp row cuts the line: a long name is what is cut ("Due 3 Nov · with Sam", "Asked to borrow"). The thing's
 * own screen says the whole of it ({@link thingStateLine}).
 */
export function thingRowLine(thing: Thing, deals: ReadonlyMap<string, ToolDealSummary> = new Map(), now: number = Date.now()): string {
    switch (thingState(thing, deals)) {
        case 'lent': {
            const lent = thing.lentTo!;
            if (!validTime(lent.backAround)) return t('With {name}', { name: lent.name });
            return Date.parse(lent.backAround) < now
                ? t('Overdue · with {name}', { name: lent.name })
                : t('Due {date} · with {name}', { name: lent.name, date: day(lent.backAround) });
        }
        case 'out': {
            const back = dealOf(thing, deals)?.backAround;
            if (!validTime(back)) return t('Out on a loan');
            return Date.parse(back) < now ? t('Out · overdue') : t('Out · due {date}', { date: day(back) });
        }
        case 'asked': return t('Asked to borrow');
        case 'listed': return t('In your shop');
        case 'taken-out': return t('Taken out of your shop');
        case 'shelf': return t('On your shelf');
    }
}

// ── The categories and conditions a thing may have ────────────────────────────────────────────────────────────────

/** A thing's category when it has none: Tools. */
export const THING_DEFAULT_CATEGORY = 'tools';

/** The Market's categories (core's, the node's ids), Tools first: what the edit screen offers. */
export function thingCategories(): Array<{ id: string; emoji: string; name: string }> {
    const all = PRICING_CATEGORIES.map((c) => ({ id: c.id as string, emoji: c.emoji, name: t(c.label) }));
    return [...all.filter((c) => c.id === THING_DEFAULT_CATEGORY), ...all.filter((c) => c.id !== THING_DEFAULT_CATEGORY)];
}

/** A category's emoji and name; an id this build doesn't know reads as General's. */
export function thingCategory(id: string | null | undefined): { id: string; emoji: string; name: string } {
    const norm = normalizeCategory(id ?? THING_DEFAULT_CATEGORY);
    const c = PRICING_CATEGORIES.find((x) => x.id === norm) ?? PRICING_CATEGORIES[PRICING_CATEGORIES.length - 1];
    return { id: c.id, emoji: c.emoji, name: t(c.label) };
}

export const THING_CONDITIONS: readonly ThingCondition[] = ['good', 'fair', 'needs_care'];

/** A condition in the member's language, or null for none (or one a newer app wrote that this build can't name). */
export function thingConditionName(condition: unknown): string | null {
    switch (condition) {
        case 'good': return t('Good');
        case 'fair': return t('Fair');
        case 'needs_care': return t('Needs care');
        default: return null;
    }
}

// ── The edit screen's fields, and saving them ──────────────────────────────────────────────────────────────────────

/** What the edit screen holds while the member types: every field as text (the longest loan too), the photo by ref. */
export interface ThingInput {
    name: string;
    category: string;
    condition: ThingCondition | '';
    replacementValue: string;
    lendTerms: string;
    lendMaxDays: string;
    ownerNote: string;
    photo: string | null;
}

/** Each field's bound, in code points, for the screens' inputs. */
export const THING_INPUT_CHARS = {
    name: THINGS_NAME_CHARS,
    replacementValue: THINGS_REPLACEMENT_VALUE_CHARS,
    lendTerms: THINGS_LEND_TERMS_CHARS,
    ownerNote: THINGS_OWNER_NOTE_CHARS,
    lendMaxDays: 3,
} as const;

/** The edit screen's fields for a thing, or blank ones (Tools, no condition) for a new thing. */
export function thingInput(thing?: Thing | null): ThingInput {
    return {
        name: thing?.name ?? '',
        category: thing?.category ?? THING_DEFAULT_CATEGORY,
        condition: THING_CONDITIONS.includes(thing?.condition as ThingCondition) ? thing!.condition as ThingCondition : '',
        replacementValue: thing?.replacementValue ?? '',
        lendTerms: thing?.lendTerms ?? '',
        lendMaxDays: typeof thing?.lendMaxDays === 'number' ? String(thing.lendMaxDays) : '',
        ownerNote: thing?.ownerNote ?? '',
        photo: typeof thing?.photo === 'string' ? thing.photo : null,
    };
}

/** The longest loan as typed: a whole number of days from 1 to a year, nothing for blank, NaN for anything else. */
function parseDays(text: string): number | undefined {
    const s = text.trim();
    if (s === '') return undefined;
    return /^\d+$/.test(s) ? Number(s) : Number.NaN;
}

/** What stops a save: no name, or a longest loan that isn't 1 to 365 days. Empty when it can be saved. */
export function thingInputProblems(input: ThingInput): Array<'name' | 'lendMaxDays'> {
    const out: Array<'name' | 'lendMaxDays'> = [];
    if (input.name.trim() === '') out.push('name');
    const days = parseDays(input.lendMaxDays);
    if (days !== undefined && !(Number.isInteger(days) && days >= 1 && days <= LEND_MAX_DAYS_MAX)) out.push('lendMaxDays');
    return out;
}

const iso = (now: number) => new Date(now).toISOString();

/** The document with one live thing changed by `change`, its updatedAt now; any other item, and an unknown id, as they were. */
function changeThing(doc: ThingsDoc, id: string, now: number, change: (t: Thing) => Thing): ThingsDoc {
    return {
        ...doc,
        things: (doc.things ?? []).map((t) => (isLiveThing(t) && t.id === id ? { ...change(t), updatedAt: iso(now) } : t)),
    };
}

/** A copy of a thing without the named fields. */
function without(t: Thing, ...keys: string[]): Thing {
    const out: Record<string, unknown> = { ...t };
    for (const k of keys) delete out[k];
    return out as Thing;
}

/**
 * The document with the edit screen's fields saved: on the thing `id`, or as a new thing `newId` at the end of the list
 * (shown first). Each field is trimmed and held to its bound; a blank optional field is left out; a new thing with no
 * category is Tools. Everything else on the thing (its Offer, who has it, a newer app's fields) is kept as it was.
 * Check thingInputProblems first: a blank name is saved as it is given.
 */
export function saveThing(doc: ThingsDoc, input: ThingInput, at: { id: string | null; newId: string; now: number }): ThingsDoc {
    const days = parseDays(input.lendMaxDays);
    const fields: Partial<Thing> = {
        name: clip(input.name.trim(), THINGS_NAME_CHARS),
        category: normalizeCategory(input.category || THING_DEFAULT_CATEGORY),
        ...(input.condition ? { condition: input.condition } : {}),
        ...(input.replacementValue.trim() ? { replacementValue: clip(input.replacementValue.trim(), THINGS_REPLACEMENT_VALUE_CHARS) } : {}),
        ...(input.lendTerms.trim() ? { lendTerms: clip(input.lendTerms.trim(), THINGS_LEND_TERMS_CHARS) } : {}),
        ...(days !== undefined && Number.isInteger(days) && days >= 1 && days <= LEND_MAX_DAYS_MAX ? { lendMaxDays: days } : {}),
        ...(input.ownerNote.trim() ? { ownerNote: clip(input.ownerNote.trim(), THINGS_OWNER_NOTE_CHARS) } : {}),
        ...(input.photo ? { photo: input.photo } : {}),
    };
    const optional = ['condition', 'replacementValue', 'lendTerms', 'lendMaxDays', 'ownerNote', 'photo'];
    if (at.id && findThing(doc, at.id)) {
        return changeThing(doc, at.id, at.now, (t) => ({ ...without(t, ...optional), ...fields } as Thing));
    }
    const made: Thing = { id: at.newId, ...fields, createdAt: iso(at.now), updatedAt: iso(at.now) } as Thing;
    return { ...doc, things: [...(doc.things ?? []), made] };
}

/**
 * Whether a document fits `maxBytes`, the host's bound (host.doc.maxBytes(): the shed's 128 KB, or less on a node that
 * keeps less), so the host will keep it. Size is the shed's one bound: there is no count of things. A change that leaves
 * it no bigger than `held`, the document as the host has it now, fits too: a shed already past the bound (kept before an
 * older node said it keeps less) can still be made smaller, a Delete or a shorter note at a time, and nothing makes it
 * bigger. The node copy sends none of it until it is under the node's bound again.
 */
export function shedFits(doc: ThingsDoc, maxBytes: number, held?: ThingsDoc): boolean {
    const bytes = toolDocBytes(doc);
    return bytes <= maxBytes || (held !== undefined && bytes <= toolDocBytes(held));
}

/**
 * A thing as most are, for the room of a shed with nothing in it yet: a short name, a category and a condition, a line of
 * how it is lent, a photo, an id and its two times, as the edit screen saves them (about 240 bytes).
 */
const TYPICAL_THING: Thing = {
    id: 'mh3k9x2a-q8w7e6r5',
    name: 'Cordless drill',
    category: 'tools',
    condition: 'good',
    lendTerms: 'Back within a week, charged.',
    photo: 'mh3k9x2a-q8w7e6r5',
    createdAt: '2026-10-23T08:37:00.000Z',
    updatedAt: '2026-10-23T08:37:00.000Z',
};

/** The bytes one more thing takes in the document: its JSON and the comma before it. */
const thingBytes = (thing: unknown) => toolDocBytes(thing) + 1;

/**
 * About how many more things fit in `maxBytes` (the host's bound, host.doc.maxBytes()): the bytes left, in things the
 * size of the member's own on average, or of a typical one while they have none. Never below 0, also for a document
 * already past the bound (one kept before an older node said it keeps less).
 */
export function shedRoom(doc: ThingsDoc, maxBytes: number): number {
    return Math.max(0, Math.floor((maxBytes - toolDocBytes(doc)) / averageThingBytes(doc)));
}

/** The bytes one of the member's things takes on average, or a typical thing while they have none. */
function averageThingBytes(doc: ThingsDoc): number {
    const live = (doc.things ?? []).filter(isLiveThing);
    return live.length > 0 ? Math.ceil(live.reduce((sum, thing) => sum + thingBytes(thing), 0) / live.length) : thingBytes(TYPICAL_THING);
}

/**
 * About how many things to delete for the document to fit `maxBytes` (a server that keeps less than the device holds):
 * the bytes over, in things the size of the member's own on average, rounded up; 0 when it fits. A Delete gives all of a
 * thing's bytes back (removeThing).
 */
export function shedToDelete(doc: ThingsDoc, maxBytes: number): number {
    const over = toolDocBytes(doc) - maxBytes;
    return over > 0 ? Math.ceil(over / averageThingBytes(doc)) : 0;
}

/**
 * The manifest's `tooBig`: switching the server's copy on found the shed more than the server keeps, so nothing changed.
 * How many things to delete, at least one (what the device sends can be a little more than the shed it shows: a tombstone
 * an earlier build kept goes with the next write), or the copy left off.
 */
export function shedTooBig(doc: ThingsDoc, maxBytes: number): ToolLine {
    return {
        key: wordn(
            "Your Tool shed holds more than your community's server keeps for now, so nothing changed. Delete about {n} thing, then switch the copy on again. Or leave it off, and your things stay on this device only.",
            "Your Tool shed holds more than your community's server keeps for now, so nothing changed. Delete about {n} things, then switch the copy on again. Or leave it off, and your things stay on this device only.",
        ),
        n: Math.max(1, shedToDelete(doc, maxBytes)),
    };
}

/** The room in a sentence, in things, never bytes: "Room for about 240 more things". */
export const shedRoomLine = (n: number) => tn(n, 'Room for about {n} more thing', 'Room for about {n} more things');

/** Said when there is no room, or a save would take the document past the host's bound: in words, never bytes. */
export const shedFullLine = () => t('Your Tool shed is full. Delete something you no longer have, or shorten some notes.');

/**
 * Said when its Offer can't be put back because the member's shop is closed for now (isShopClosedRefusal): nothing goes
 * back in it until it is reopened. Not "back when it reopens": an Offer its owner paused stays paused then.
 */
export const shopClosedLine = () => t("Your shop is closed for now, so this can't go back in it yet. Reopen your shop first.");

/**
 * The document with a thing deleted: taken out of the list, every other item where it was, and nothing of it kept, so
 * a Delete gives back all the room the thing took and the shed never fills with things that are gone. No tombstone is
 * needed: the sync takes or sends the document whole, last writer wins (reconcile.ts; node-copy.ts runStep), and nothing
 * reads one, on a device or on the node. A copy that took this document has no thing to bring back; one that never did
 * is the older document, which loses to this one or wins whole, tombstone or not ("one device at a time"). The host
 * removes its photo.
 */
export function removeThing(doc: ThingsDoc, id: string, _now: number): ThingsDoc {
    return { ...doc, things: (doc.things ?? []).filter((t) => !(isLiveThing(t) && t.id === id)) };
}

/** When a thing is due back, `days` from now (the "back around" chips), as an ISO time. */
export const backAroundIn = (now: number, days: number): string => iso(now + days * DAY_MS);

/** The "back around" chips, in days. */
export const BACK_AROUND_DAYS: readonly number[] = [3, 7, 14, 30];

/** A "back around" chip's words: "In 3 days". */
export const backAroundChip = (days: number) => tn(days, 'In {n} day', 'In {n} days');

/** The document with a thing lent to someone outside BeanPool: their name as the member wrote it, since now, and when it is due back. */
export function lendOutside(doc: ThingsDoc, id: string, name: string, backAround: string | null, now: number): ThingsDoc {
    return changeThing(doc, id, now, (t) => ({
        ...t,
        lentTo: { name: clip(name.trim(), THINGS_NAME_CHARS), since: iso(now), ...(backAround ? { backAround } : {}) },
    }));
}

/** The document with a thing lent outside BeanPool back home. */
export function markBack(doc: ThingsDoc, id: string, now: number): ThingsDoc {
    return changeThing(doc, id, now, (t) => without(t, 'lentTo'));
}

/** The document with a thing linked to its Offer in the Market (posted from its List draft, or put back in the shop). */
export function setListed(doc: ThingsDoc, id: string, postId: string, now: number): ThingsDoc {
    return changeThing(doc, id, now, (t) => ({ ...without(t, 'pausedPostId'), postId }));
}

/** The document with a thing taken out of the shop: its Offer paused and kept, so listing it again resumes the same one. */
export function takeOutOfShop(doc: ThingsDoc, id: string, now: number): ThingsDoc {
    return changeThing(doc, id, now, (t) => (typeof t.postId === 'string' ? { ...without(t, 'postId'), pausedPostId: t.postId } : t));
}

/** The document with a thing's Offer forgotten (gone from the Market): the thing is back on the shelf. */
export function forgetOffer(doc: ThingsDoc, id: string, now: number): ThingsDoc {
    return changeThing(doc, id, now, (t) => without(t, 'postId', 'pausedPostId'));
}

/**
 * The document with a thing linked to one of the owner's Offers (host.posts.mine): a live one, or one in a deal, puts it
 * in the shop; a paused one is kept as taken out, so Put back resumes it.
 */
export function linkOffer(doc: ThingsDoc, id: string, offer: { id: string; status: string }, now: number): ThingsDoc {
    return offer.status === 'paused'
        ? changeThing(doc, id, now, (t) => ({ ...without(t, 'postId'), pausedPostId: offer.id }))
        : setListed(doc, id, offer.id, now);
}

/** The Offers a thing may be linked to: the owner's own, live or paused, that no other thing the member has is linked to. */
export function offersToLink<O extends { id: string; status: string }>(doc: ThingsDoc, offers: readonly O[], id: string): O[] {
    const taken = new Set<string>();
    for (const t of doc.things ?? []) {
        if (!isLiveThing(t) || t.id === id) continue;
        if (typeof t.postId === 'string') taken.add(t.postId);
        if (typeof t.pausedPostId === 'string') taken.add(t.pausedPostId);
    }
    return offers.filter((o) => o.status !== 'gone' && !taken.has(o.id));
}

// ── The List draft ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What List hands the host's door for a thing: its name, terms and photo, its category, as a lendable Offer in the
 * member's shop. The fields a server slice adds (lendable, replacementValue, lendMaxDays, shop) are dropped by a host
 * whose composer can't take them yet, so what they would have said is in the words too, in the member's language, for
 * the member to check before they post.
 */
export function thingListDraft(thing: Thing): ToolOfferDraft {
    const lines = [
        thing.lendTerms?.trim() ?? '',
        thing.replacementValue?.trim()
            ? t("If it's lost or broken: {value}. That is settled between us; BeanPool doesn't hold or collect it.", { value: thing.replacementValue.trim() })
            : '',
        typeof thing.lendMaxDays === 'number' ? tn(thing.lendMaxDays, 'Lent for up to {n} day at a time.', 'Lent for up to {n} days at a time.') : '',
    ].filter(Boolean);
    return {
        title: thing.name,
        description: lines.join('\n\n'),
        category: normalizeCategory(thing.category ?? THING_DEFAULT_CATEGORY),
        photos: typeof thing.photo === 'string' ? [thing.photo] : [],
        lendable: true,
        ...(thing.replacementValue ? { replacementValue: thing.replacementValue } : {}),
        ...(typeof thing.lendMaxDays === 'number' ? { lendMaxDays: thing.lendMaxDays } : {}),
        shop: true,
    };
}

// ── Loans ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One loan on the Loans screen: a thing lent outside BeanPool, out on a BeanPool loan, or asked for. */
export interface ThingLoan {
    thing: Thing;
    state: 'lent' | 'out' | 'asked';
    /** When it went out (outside) or the deal last changed (asked for, or agreed). */
    since: string | null;
    backAround: string | null;
    overdue: boolean;
}

/**
 * Everything of the member's that is out or asked for, from the document (lent outside BeanPool) and the owner's deals
 * on the Offers its things are linked to: overdue first, then the soonest back, then the rest by when they went out.
 */
export function thingsLoans(doc: ThingsDoc, deals: readonly ToolDealSummary[] | null | undefined, now: number): ThingLoan[] {
    const open = openDealsByPost(deals);
    const out: ThingLoan[] = [];
    for (const thing of (doc.things ?? []).filter(isLiveThing)) {
        const state = thingState(thing, open);
        if (state === 'lent') {
            const back = validTime(thing.lentTo!.backAround) ? thing.lentTo!.backAround! : null;
            out.push({ thing, state, since: validTime(thing.lentTo!.since) ? thing.lentTo!.since : null, backAround: back, overdue: back !== null && Date.parse(back) < now });
        } else if (state === 'out' || state === 'asked') {
            const deal = dealOf(thing, open)!;
            const back = state === 'out' && validTime(deal.backAround) ? deal.backAround : null;
            out.push({ thing, state, since: validTime(deal.updatedAt) ? deal.updatedAt : null, backAround: back, overdue: back !== null && Date.parse(back) < now });
        }
    }
    const at = (s: string | null) => (s === null ? Number.POSITIVE_INFINITY : Date.parse(s));
    return out.sort((a, b) => Number(b.overdue) - Number(a.overdue) || at(a.backAround) - at(b.backAround) || at(a.since) - at(b.since));
}
