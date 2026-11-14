/**
 * This community's typed tags (DESIGN-tags-free-entry-fable.md §5, slice F3): which of the tags members typed on listings
 * here (posts.free_tags, slice F1) the Tags field offers to other members as they type, and the owners' and admins' rules
 * on them (free_tag_rules: hide, or merge into a library tag).
 *
 * Counted over live listings made here and on the board for everyone: active, not hidden by reports, not taken down by a
 * moderator, made on this server (a peer's tags show on its listings and are never offered here), public (a group's or
 * one person's listing lends nobody its words), and by an author who is active (not paused or suspended). A tag is
 * offered only when it is on two distinct authors' listings, or has been on a live listing here for a week with no open
 * report on any listing carrying it, and no 'hide' rule holds it. The week runs from when the WORD first appeared on a
 * live listing (free_tag_seen), not from the listing: an author who edits a new word onto an old listing, or whose listing
 * comes back from a long pause, waits the week like anyone. So a slur typed once stays on that one listing until it is
 * reported or deleted, and never reaches the picker. A 'merge' rule offers the tag whatever its counts: an owner or admin
 * chose it, and the field stores the library id it names. Rebuilt at most once a minute (a json_each over the live
 * listings); a rule set here is seen at once.
 *
 * Not applied (noted in the design): a reader's own block list (a suggestion is a word, not a listing).
 */
import { freeTagRefusal, freeTagStored, isTagId, word } from '@beanpool/core';
import { db, deletePlainRows } from '../db/db.js';
import { assertPlainTablesWritable } from '../config/node-role.js';

/** Distinct authors whose live listings carry a tag before it is offered. */
export const FREE_TAG_OFFER_AUTHORS = 2;
/** Or the days the word has been on a live listing here (free_tag_seen), with no open report on a listing carrying it. */
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
     * When the word first appeared on a live listing here, in its present unbroken run (an edit that puts it on one starts
     * the run then), or null when none carries it now (a rule outlives its listings).
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

const OPEN_REPORT = `EXISTS (SELECT 1 FROM abuse_reports r WHERE r.target_post_id = p.id AND r.target_pulse_item_id IS NULL
    AND (r.status = 'pending' OR r.status IS NULL))`;

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
 * Keeps free_tag_seen to the words on a live listing here now: a word new to them is stamped `now`, and a word on none
 * any more loses its stamp, so when it comes back its week starts again. Run by every count, on each side of an author's
 * change to a listing's typed tags (engine/posts.ts: so a word taken off every live listing since the last count, then
 * edited onto another, starts again at that edit), and hourly on a main server (state-engine.ts: so a quiet community's
 * listing back from a long pause is not held to the day before it). Each server keeps its own (the manifest: local).
 */
export function noteFreeTagsSeen(now: number = Date.now()): void {
    const at = new Date(now).toISOString();
    db.transaction(() => {
        db.prepare(`DELETE FROM free_tag_seen WHERE tag NOT IN (SELECT j.value ${LIVE_TAGS_FROM} ${LIVE_TAGS_WHERE})`).run();
        db.prepare(`INSERT OR IGNORE INTO free_tag_seen (tag, first_seen) SELECT DISTINCT j.value, @at ${LIVE_TAGS_FROM} ${LIVE_TAGS_WHERE}`).run({ at });
    })();
}

let counted: { at: number; list: FreeTagCount[] } | null = null;

/** Every typed tag on a live listing here, and every tag a rule names, most used first. Made at most once a minute. */
export function freeTagCounts(now: number = Date.now()): FreeTagCount[] {
    if (counted && now - counted.at >= 0 && now - counted.at < FREE_TAG_COUNT_MS) return counted.list;
    noteFreeTagsSeen(now);
    const weekAgo = new Date(now - FREE_TAG_OFFER_DAYS * 86_400_000).toISOString();
    // A word with no stamp (none can be, just after noteFreeTagsSeen) is never old enough: first_seen NULL fails the week.
    const rows = db.prepare(`
        SELECT j.value AS tag, COUNT(DISTINCT p.id) AS listings, COUNT(DISTINCT p.author_pubkey) AS authors, MIN(s.first_seen) AS first_seen,
               MAX(CASE WHEN ${OPEN_REPORT} THEN 1 ELSE 0 END) AS reported
        ${LIVE_TAGS_FROM}
        LEFT JOIN free_tag_seen s ON s.tag = j.value
        ${LIVE_TAGS_WHERE}
        GROUP BY j.value
    `).all() as { tag: string; listings: number; authors: number; first_seen: string | null; reported: number }[];
    const rules = new Map((db.prepare('SELECT tag, action, into_tag FROM free_tag_rules').all() as { tag: string; action: FreeTagRuleAction; into_tag: string | null }[])
        .map((r) => [r.tag, r]));
    const list: FreeTagCount[] = rows.map((r) => {
        const rule = rules.get(r.tag);
        rules.delete(r.tag);
        const aged = r.first_seen !== null && r.first_seen <= weekAgo && r.reported === 0;
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
