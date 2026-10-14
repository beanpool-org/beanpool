// What a listing's own fields may hold, on the way in. One set of rules for making a post and for editing one.
//
// WHY THIS EXISTS (review F1/F2, 2026-10-01, measured). The create route turned what it was sent into a number
// (`Number(credits) || 0`) and the edit route passed it straight through, so a seller could edit their own offer to
// `{"credits": "abc"}`. SQLite stored the text in the REAL column, and the first buyer approved or one-step accepted
// had their balance set to NaN in memory and NULL on disk: every `<` guard on the money path reads NaN as "fine". The
// same edit stored any JSON type in title, description, category, priceType, lat and lng.
//
// Every post is made through state-engine `createPost` and edited through state-engine `updatePost` (the marketplace
// routes, the enterprise's own routes, events, the Daily Pulse), and both ask this before anything else. A refusal is
// a plain Error, which each route answers as 400, and nothing is written.

// LENGTH LIMITS ON THE TEXT (#1493, global launch). Until then the request body (2 MB) was the only bound, and every list
// of listings sends a listing's title, description and category whole for each row, so one member's 2 MB descriptions
// could make a page of 200 listings 400 MB. Each is held to its limit (@beanpool/core text-limits.ts) here, on a create
// and on an edit. An edit that sends back the text a listing already holds is not a new one: a listing stored before its
// limit, longer, can still be edited (the phone's edit screen sends every field back), and keeps that text until its
// author changes it. The node never cuts what is stored: lists send it as it is (the apps keep their copy of every
// listing from them and edit from that copy, so a list's preview would be shown and saved as the text).
// test-posts-fts-same-ms makes its oversized titles through the engine's own writer, past this check, on purpose.

import {
    LISTING_CATEGORY_LIMIT, LISTING_DESCRIPTION_LIMIT, LISTING_TITLE_LIMIT, fitsTextLimit, replaceLoneSurrogates, textTooLongMessage, type TextLimit,
} from '@beanpool/core';

/** The most Beans one listing may ask, per unit: far above any real price, and far below where arithmetic misbehaves. */
export const POST_CREDITS_MAX = 1_000_000;
/** The most units (hours, days, …) one deal may be for. */
export const POST_HOURS_MAX = 10_000;
/**
 * The fewest units one deal may be for: 0.01 of an hour, day, week or month (36 seconds of an hour). The apps' own
 * fields go no lower (PWA: min 0.5 to confirm, 1 to book, any positive number typed; native: any number typed; the
 * enterprise's prompt: any positive number), and no real booking does. Without it `5e-324` hours passed, and a deal's
 * rate (its credits over its hours, escrow.ts) rounded: a 0.4 Beans/h Offer booked at 5e-324 h paid 0 for 10 hours
 * (#1445 review, BLOCKING 2).
 */
export const POST_HOURS_MIN = 0.01;
/** How a price is counted: once, or per unit. The set the apps offer (native treasury-post, PWA) and escrow handles. */
export const POST_PRICE_TYPES = ['fixed', 'hourly', 'daily', 'weekly', 'monthly'] as const;

/** The fields this checks, as a create or an edit carries them. An edit names only what it changes. */
export interface PostFieldsIn {
    title?: unknown;
    description?: unknown;
    category?: unknown;
    credits?: unknown;
    priceType?: unknown;
    lat?: unknown;
    lng?: unknown;
    hours?: unknown;
}

/** A number of units for a deal: finite, from POST_HOURS_MIN to POST_HOURS_MAX. */
export function isDealQuantity(v: unknown): v is number {
    return typeof v === 'number' && Number.isFinite(v) && v >= POST_HOURS_MIN && v <= POST_HOURS_MAX;
}

/** The refusal for a quantity that is given but isn't one (isDealQuantity), at a door where a fixed price ignores it. */
export const DEAL_QUANTITY_ERROR = `The quantity must be a number from ${POST_HOURS_MIN} to ${POST_HOURS_MAX}`;

/**
 * A deal quantity as a request body carries it, for the escrow doors to judge (sync check F3, 2026-10-02): undefined when
 * none is given (absent or null); a number as it is; a numeric string as its number (`Number("2.5")`). Anything else —
 * text that isn't a number, "", true, [2], an object — is NaN, which every door refuses. The routes used to drop a
 * quantity they couldn't read and pay the booked hours, and `Number(true)` read as 1.
 */
export function dealQuantityFromBody(raw: unknown): number | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string' && raw.trim() !== '') return Number(raw);
    return NaN;
}

/** A listing's price in Beans: a finite number, 0 or more, at most POST_CREDITS_MAX. */
export function isListingPrice(v: unknown): v is number {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= POST_CREDITS_MAX;
}

/** A listing's text the rule refuses for its length, in the words both apps show. */
export const LISTING_TITLE_TOO_LONG = textTooLongMessage("A listing's title", LISTING_TITLE_LIMIT);
export const LISTING_DESCRIPTION_TOO_LONG = textTooLongMessage("A listing's description", LISTING_DESCRIPTION_LIMIT);
export const LISTING_CATEGORY_TOO_LONG = textTooLongMessage("A listing's category", LISTING_CATEGORY_LIMIT);

function text(fields: PostFieldsIn, key: 'title' | 'description' | 'category', label: string, required: boolean, limit: TextLimit, tooLong: string, stored: unknown): void {
    const raw = fields[key];
    if (typeof raw !== 'string') throw new Error(`${label} must be text`);
    if (required && raw.trim().length === 0) throw new Error(`${label} is required`);
    const v = replaceLoneSurrogates(raw);
    fields[key] = v;
    // The text the listing already holds, sent back by an edit, is not new: kept, however long it was stored.
    if (v !== stored && !fitsTextLimit(v, limit)) throw new Error(tooLong);
}

function coordinate(v: unknown, label: string, bound: number, mode: 'create' | 'edit'): void {
    // An edit may clear a pin (null); a create names none by leaving it out.
    if (v === null && mode === 'edit') return;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < -bound || v > bound) {
        throw new Error(`${label} must be a number from -${bound} to ${bound}`);
    }
}

/** What a listing holds now, for an edit: its text sent back unchanged is not held to a limit it was stored before. */
export interface PostTextStored {
    title?: unknown;
    description?: unknown;
    category?: unknown;
}

/**
 * Refuses a post's fields that no listing may hold. `create`: every field the post will be stored with (the title
 * required). `edit`: only the fields the edit names (not undefined), each held to the same rule; `stored` is the listing
 * as it is, whose own text sent back is not held to the length limits.
 */
export function assertPostFields(fields: PostFieldsIn, mode: 'create' | 'edit', stored: PostTextStored = {}): void {
    const has = (k: keyof PostFieldsIn) => fields[k] !== undefined;
    if (mode === 'create' || has('title')) text(fields, 'title', 'Title', true, LISTING_TITLE_LIMIT, LISTING_TITLE_TOO_LONG, stored.title);
    if (has('description')) text(fields, 'description', 'Description', false, LISTING_DESCRIPTION_LIMIT, LISTING_DESCRIPTION_TOO_LONG, stored.description);
    if (has('category')) text(fields, 'category', 'Category', true, LISTING_CATEGORY_LIMIT, LISTING_CATEGORY_TOO_LONG, stored.category);
    if (has('credits') && !isListingPrice(fields.credits)) {
        throw new Error(`The price must be a number of Beans from 0 to ${POST_CREDITS_MAX}`);
    }
    if (has('priceType') && !(POST_PRICE_TYPES as readonly unknown[]).includes(fields.priceType)) {
        throw new Error(`The price type must be one of ${POST_PRICE_TYPES.join(', ')}`);
    }
    if (has('lat')) coordinate(fields.lat, 'Latitude', 90, mode);
    if (has('lng')) coordinate(fields.lng, 'Longitude', 180, mode);
    if (has('hours') && !isDealQuantity(fields.hours)) throw new Error(DEAL_QUANTITY_ERROR);
}
