/**
 * This community's typed tags (DESIGN-tags-free-entry-fable.md §5, slice F3): which of the tags members typed on listings
 * here (posts.free_tags, slice F1) the Tags field offers to other members as they type, and the owners' and admins' rules
 * on them (free_tag_rules: hide, or merge into a library tag).
 *
 * Counted over live listings made here and on the board for everyone: active, not hidden by reports, not taken down by a
 * moderator, made on this server (a peer's tags show on its listings and are never offered here), public (a group's or
 * one person's listing lends nobody its words), and by an author who is active (not paused or suspended). A tag is
 * offered only when it is on two distinct authors' listings, or when one live listing here has carried it for a week and
 * nothing holds it, and no 'hide' rule holds it. The week is one LISTING's own with that word (free_tag_seen, a stamp per
 * word per listing), not the listing's age and not the word's: an author who edits a new word onto an old listing, whose
 * listing comes back from a long pause, or who moves the word to another listing, waits the week like anyone. What holds
 * a word (stampHolds): any listing that carries it or carried it has a report open; or has a report a moderator upheld, or
 * was taken down by a moderator or hidden by reports, for a week from the latest of those and the word leaving it. So a
 * report follows the word when its author moves it to a new listing and takes it off, pauses or deletes the reported one,
 * and upholding that report, before or after the move, holds the author's copy elsewhere for a week after the latest of
 * the move and the uphold (an owner or admin hides a word for good). A slur typed once stays on that one listing until it
 * is reported or deleted, and never reaches the picker. A 'merge' rule offers the tag whatever its counts: an owner or
 * admin chose it, and the field stores the library id it names. Rebuilt at most once a minute (a json_each over the live
 * listings); a rule set here is seen at once.
 *
 * Not applied (noted in the design): a reader's own block list (a suggestion is a word, not a listing).
 */
import {
    LANGS, TAG_LIBRARY, compoundWords, exactTagForms, freeTagRefusal, freeTagStored, isTagId, lookupPhrase, tagEnglish, word, wordsFor,
    type Lang,
} from '@beanpool/core';
import { db, deletePlainRows } from '../db/db.js';
import { assertPlainTablesWritable } from '../config/node-role.js';
import { coreCatalogOnce } from '../member-words.js';

/** Distinct authors whose live listings carry a tag before it is offered. */
export const FREE_TAG_OFFER_AUTHORS = 2;
/** Or the days one live listing here has carried the word itself (free_tag_seen), with nothing holding it (see above). */
export const FREE_TAG_OFFER_DAYS = 7;
/** How long one count is used before it is made again. */
export const FREE_TAG_COUNT_MS = 60_000;
/** The most tags GET /api/free-tags offers (the most used), besides every merged one. */
export const FREE_TAGS_OFFERED_MAX = 200;

export type FreeTagRuleAction = 'hide' | 'merge';

/** A typed tag as the owners' and admins' Tags page reads it: counts, never who. */
export interface FreeTagCount {
    tag: string;
    listings: number;
    authors: number;
    /**
     * The earliest day a listing carrying the word now began to carry it, in that listing's present run (an edit that puts
     * it on a listing, or the listing back from a pause, starts the run then), or null when none carries it now (a rule
     * outlives its listings).
     */
    firstSeen: string | null;
    /** Whether members are offered it as they type. */
    offered: boolean;
    rule: FreeTagRuleAction | null;
    mergeInto: string | null;
}

/** One tag the Tags field may offer: what GET /api/free-tags answers (core community-tags.ts reads it). */
export interface OfferedFreeTag {
    tag: string;
    listings: number;
    mergeInto?: string;
}

export const FREE_TAG_RULE_WORDS = {
    notATag: word('That is not a tag a listing can carry.'),
    notLibrary: word('Choose a tag from the library to merge it into.'),
    noAction: word('Choose hide, merge or clear.'),
} as const;

export class FreeTagRuleError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message);
    }
}

const DAY_MS = 86_400_000;

/** An open report on the listing `postId` names (a column): pending, or from before reports kept a status. */
const openReportOn = (postId: string) => `EXISTS (SELECT 1 FROM abuse_reports r WHERE r.target_post_id = ${postId}
    AND r.target_pulse_item_id IS NULL AND (r.status = 'pending' OR r.status IS NULL))`;

/** When a moderator last upheld a report on the listing `postId` names (a column): its latest actioned report, or NULL. */
const upheldAt = (postId: string) => `(SELECT MAX(r.updated_at) FROM abuse_reports r WHERE r.target_post_id = ${postId}
    AND r.target_pulse_item_id IS NULL AND r.status = 'actioned')`;

/**
 * The one rule that holds the word a stamp `s` kept (its listing `hp`, which may be missing): a report on that listing is
 * open; or a moderator upheld a report on it (actioned, by any route: with or without taking it down, on a listing its
 * author had already paused, edited or deleted), or it was taken down by a moderator or hidden by reports, and the latest
 * of those and of the word leaving it (`s.gone_at`) is under a week ago (`@weekAgo`). So whatever way the word left the
 * listing, and whenever the report was upheld, the word waits a week after the latest of them: upholding a report never
 * frees the word sooner than leaving it open would. An upheld report counts by its own row, not by a takedown stamp,
 * because a listing that was not live when it was upheld gets no stamp (auto-mute counts only live takedowns,
 * state-engine.ts removePostByAdmin). The hold and the prune read this same SQL, so the stamp is still there when the hold
 * looks. Every one of these is an ISO time (iso(now), strftime), so the strings compare as times.
 */
const stampHolds = (s: string, hp: string) => {
    const events = `COALESCE(${hp}.removed_by_moderator_at, ''), COALESCE(${hp}.hidden_by_reports_at, ''), COALESCE(${upheldAt(`${s}.post_id`)}, '')`;
    return `(${openReportOn(`${s}.post_id`)} OR (MAX(${events}) != '' AND MAX(COALESCE(${s}.gone_at, ''), ${events}) > @weekAgo))`;
};

/** Each typed tag on each live listing here (posts p, its author m, the tag j): what is counted, and what free_tag_seen keeps. */
const LIVE_TAGS_FROM = `
        FROM posts p
        JOIN members m ON m.public_key = p.author_pubkey
        JOIN json_each(CASE WHEN json_valid(p.free_tags) THEN p.free_tags ELSE '[]' END) j`;
const LIVE_TAGS_WHERE = `
        WHERE p.free_tags != '' AND j.type = 'text'
          AND COALESCE(p.active, 0) = 1 AND p.status = 'active' AND p.audience_scope = 'public'
          AND p.hidden_by_reports_at IS NULL AND p.removed_by_moderator_at IS NULL AND p.origin_node IS NULL
          AND m.status = 'active'`;

/**
 * Keeps free_tag_seen to the words on each listing here: a listing that carries a word live and had no stamp for it, or
 * had stopped carrying it, is stamped `now` (its own week starts); a listing that stopped carrying one live is marked gone
 * `now`; a stamp gone for over a week that nothing holds (stampHolds: no report open on its listing, and no upheld report,
 * takedown or hide on it still inside its week) is dropped. Run by every count, on each side of an author's change to a
 * listing's typed tags (engine/posts.ts: so a word taken off a listing since the last count, then edited back onto it,
 * starts again at that edit), and hourly on every server (state-engine.ts: so a quiet community's listing back from a long
 * pause is not held to the day before it, and a standby's stamps follow its copy). Each server keeps its own (the
 * manifest: local).
 */
export function noteFreeTagsSeen(now: number = Date.now()): void {
    const at = new Date(now).toISOString();
    const weekAgo = new Date(now - FREE_TAG_OFFER_DAYS * DAY_MS).toISOString();
    db.transaction(() => {
        db.prepare(`UPDATE free_tag_seen SET gone_at = @at WHERE gone_at IS NULL AND NOT EXISTS (
            SELECT 1 ${LIVE_TAGS_FROM} ${LIVE_TAGS_WHERE} AND p.id = free_tag_seen.post_id AND j.value = free_tag_seen.tag)`).run({ at });
        db.prepare(`INSERT INTO free_tag_seen (tag, post_id, first_seen) SELECT DISTINCT j.value, p.id, @at ${LIVE_TAGS_FROM} ${LIVE_TAGS_WHERE}
            ON CONFLICT (tag, post_id) DO UPDATE SET first_seen = excluded.first_seen, gone_at = NULL WHERE free_tag_seen.gone_at IS NOT NULL`).run({ at });
        db.prepare(`DELETE FROM free_tag_seen WHERE (tag, post_id) IN (SELECT s.tag, s.post_id FROM free_tag_seen s LEFT JOIN posts hp ON hp.id = s.post_id
            WHERE s.gone_at IS NOT NULL AND s.gone_at <= @weekAgo AND NOT ${stampHolds('s', 'hp')})`).run({ weekAgo });
    })();
}

let counted: { at: number; list: FreeTagCount[] } | null = null;

/** Every typed tag on a live listing here, and every tag a rule names, most used first. Made at most once a minute. */
export function freeTagCounts(now: number = Date.now()): FreeTagCount[] {
    if (counted && now - counted.at >= 0 && now - counted.at < FREE_TAG_COUNT_MS) return counted.list;
    noteFreeTagsSeen(now);
    const weekAgo = new Date(now - FREE_TAG_OFFER_DAYS * DAY_MS).toISOString();
    // A listing with no stamp (none can be, just after noteFreeTagsSeen) is never old enough: first_seen NULL fails the week.
    const rows = db.prepare(`
        SELECT j.value AS tag, COUNT(DISTINCT p.id) AS listings, COUNT(DISTINCT p.author_pubkey) AS authors, MIN(s.first_seen) AS first_seen
        ${LIVE_TAGS_FROM}
        LEFT JOIN free_tag_seen s ON s.tag = j.value AND s.post_id = p.id
        ${LIVE_TAGS_WHERE}
        GROUP BY j.value
    `).all() as { tag: string; listings: number; authors: number; first_seen: string | null }[];
    // The words held: a listing that carries or carried one (its stamp kept) has a report open, or a report on it upheld, or it was
    // taken down or hidden by reports, and the latest of those and the word leaving it is under a week ago (stampHolds, the prune's
    // rule too).
    const held = new Set((db.prepare(`
        SELECT DISTINCT s.tag FROM free_tag_seen s LEFT JOIN posts hp ON hp.id = s.post_id
        WHERE ${stampHolds('s', 'hp')}
    `).all({ weekAgo }) as { tag: string }[]).map((r) => r.tag));
    const rules = new Map((db.prepare('SELECT tag, action, into_tag FROM free_tag_rules').all() as { tag: string; action: FreeTagRuleAction; into_tag: string | null }[])
        .map((r) => [r.tag, r]));
    const list: FreeTagCount[] = rows.map((r) => {
        const rule = rules.get(r.tag);
        rules.delete(r.tag);
        const aged = r.first_seen !== null && r.first_seen <= weekAgo && !held.has(r.tag);
        const passes = r.authors >= FREE_TAG_OFFER_AUTHORS || aged;
        return {
            tag: r.tag, listings: r.listings, authors: r.authors, firstSeen: r.first_seen,
            offered: rule?.action === 'merge' || (passes && rule?.action !== 'hide'),
            rule: rule?.action ?? null, mergeInto: rule?.into_tag ?? null,
        };
    });
    for (const rule of rules.values()) {
        list.push({ tag: rule.tag, listings: 0, authors: 0, firstSeen: null, offered: rule.action === 'merge', rule: rule.action, mergeInto: rule.into_tag });
    }
    list.sort((a, b) => b.listings - a.listings || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
    counted = { at: now, list };
    return list;
}

/** The count is made again at the next read: a rule just set is seen at once. */
export function forgetFreeTagCounts(): void {
    counted = null;
}

/** The tags the Tags field offers members here: the most used that pass, and every merged one. */
export function offeredFreeTags(now: number = Date.now()): OfferedFreeTag[] {
    const out: OfferedFreeTag[] = [];
    let plain = 0;
    for (const c of freeTagCounts(now)) {
        if (!c.offered) continue;
        if (c.mergeInto) out.push({ tag: c.tag, listings: c.listings, mergeInto: c.mergeInto });
        else if (plain++ < FREE_TAGS_OFFERED_MAX) out.push({ tag: c.tag, listings: c.listings });
    }
    return out;
}

/** The tag a rule is about, in its stored form, or a refusal: a rule is only ever on a tag a listing could carry. */
function ruleTag(text: unknown): string {
    if (typeof text !== 'string' || freeTagRefusal(text) !== null) throw new FreeTagRuleError(400, 'not_a_tag', FREE_TAG_RULE_WORDS.notATag);
    return freeTagStored(text);
}

/**
 * Sets a rule on a typed tag ('hide', 'merge' into a library tag) or clears it, in the name of the owner or admin who did.
 * A merge names a library tag below a top (the category is its own field). Changes nothing when the rule already stands;
 * `changed` says which. Refused on a standby (the rules are its main server's rows).
 */
export function setFreeTagRule(actor: string, key: unknown, action: unknown, into?: unknown): { tag: string; rule: FreeTagRuleAction | null; mergeInto: string | null; changed: boolean } {
    if (action !== 'hide' && action !== 'merge' && action !== 'clear') throw new FreeTagRuleError(400, 'bad_action', FREE_TAG_RULE_WORDS.noAction);
    const tag = ruleTag(key);
    const target = action === 'merge' ? into : null;
    if (action === 'merge' && (typeof target !== 'string' || !target.includes('.') || !isTagId(target))) {
        throw new FreeTagRuleError(400, 'not_library', FREE_TAG_RULE_WORDS.notLibrary);
    }
    assertPlainTablesWritable();
    const before = db.prepare('SELECT action, into_tag FROM free_tag_rules WHERE tag = ?').get(tag) as { action: FreeTagRuleAction; into_tag: string | null } | undefined;
    let changed: boolean;
    if (action === 'clear') {
        changed = !!before && deletePlainRows('free_tag_rules', 'tag = ?', tag) > 0;
    } else {
        changed = before?.action !== action || (before?.into_tag ?? null) !== (target ?? null);
        if (changed) {
            db.prepare(`INSERT INTO free_tag_rules (tag, action, into_tag, set_by, set_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                        ON CONFLICT(tag) DO UPDATE SET action = excluded.action, into_tag = excluded.into_tag, set_by = excluded.set_by, set_at = excluded.set_at`)
                .run(tag, action, target ?? null, actor);
        }
    }
    if (changed) forgetFreeTagCounts();
    return { tag, rule: action === 'clear' ? null : action, mergeInto: action === 'merge' ? target as string : null, changed };
}

// ── "Did you mean …?" from every language's labels (DESIGN-tags-free-entry-fable.md §3, slice F5) ─────────────────────

/** A library tag a word is the label of, and the language of that label (a code from core's LANGS). */
export interface LabelElsewhere {
    id: string;
    lang: Lang;
}

/**
 * Every library tag's label in all 25 languages, keyed EXACTLY (core exactTagForms: the index's words and compound join,
 * lower case, NFC, every mark and letter kept), each to the tag it names and the language it is a label in. A device holds
 * its own language and English, so a word that is a label in a third language ("limão-siciliano" on a Spanish phone) is
 * found here, and the field offers that tag above the member's own word, saying the language. Exact, never folded (Fable,
 * 15 Nov): across languages a fold makes one language's word another's ("Cát", sand in Vietnamese, as "cat"); folding stays
 * inside the device's own index, where a member types their own words without marks. English first, then the languages in
 * LANGS order: where two languages write a label alike and name different tags, the earlier one keeps the key (the device
 * has already resolved its own language and English before it asks). Never a top: the category is its own field. Built
 * from core's catalog files on the first ask, once, keeping nothing of the catalogs but these keys (the ids and codes are
 * the library's and LANGS' own strings); a node nobody asks never builds it.
 */
let labelMap: Map<string, LabelElsewhere> | null = null;

function buildLabelMap(): Map<string, LabelElsewhere> {
    const map = new Map<string, LabelElsewhere>();
    const items = TAG_LIBRARY.filter((tag) => tag.id.includes('.'));
    for (const lang of LANGS) {
        const catalog = lang === 'en' ? null : coreCatalogOnce(lang);
        if (lang !== 'en' && !catalog) continue;
        const words = wordsFor(lang, catalog ? [catalog] : []);
        for (const tag of items) {
            const label = lang === 'en' ? tagEnglish(tag) : words.t(tag.en) || tagEnglish(tag);
            for (const key of exactTagForms(label)) if (key && !map.has(key)) map.set(key, { id: tag.id, lang });
        }
    }
    return map;
}

/**
 * The library tag a typed word is the label of, in any of the 25 languages, looked up exactly as the map keys a label (an
 * English plural's singular too, as the apps' exactLibraryTag reads one), with that label's language; or null. What GET
 * /api/free-tags?q= answers as `library` and `lang`. Only a word a listing could carry as its own tag is looked up
 * (freeTagRefusal), so the work is bounded by the tag rule's 30 characters.
 */
export function libraryTagNamed(text: unknown): LabelElsewhere | null {
    if (typeof text !== 'string' || freeTagRefusal(text) !== null) return null;
    const map = labelMap ?? (labelMap = buildLabelMap());
    // lookupPhrase asks for the phrase, then its singulars: each answers the first of its forms the map keys.
    const key = lookupPhrase(compoundWords(freeTagStored(text)), (phrase) => exactTagForms(phrase).filter((k) => map.has(k)).slice(0, 1))[0];
    return key === undefined ? null : map.get(key) ?? null;
}

/** How many labels the map holds, building it if it was not (the tests, and the measure in the F5 PR). */
export function libraryLabelCount(): number {
    return (labelMap ?? (labelMap = buildLabelMap())).size;
}
