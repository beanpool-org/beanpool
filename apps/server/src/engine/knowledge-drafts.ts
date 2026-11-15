/**
 * Local knowledge's waiting list (slice K3; scratch/fable-design/DESIGN-local-knowledge-fable.md §2.2, §2.4, §4.1, §5, as
 * amended by DESIGN-local-knowledge-amend-fable.md; every pick Marty's, 11 Nov 2026). The routes are routes/knowledge.ts;
 * engine/knowledge.ts publishKnowledge is still the only code that makes a page.
 *
 * ## What waits is never a post
 *
 * A member's suggestion waits in `knowledge_drafts`, its photos in `knowledge_draft_photos`. Only an owner's or admin's
 * approval makes the page, through publishKnowledge, with the member as its writer: so nothing unapproved reaches a list,
 * a search, a sync, a count or the posts a standby copies by a missed filter, and a writer can't get one approved and then
 * change the words (a later change waits again: K5's fix).
 *
 * ## A fix (slice K5, §3.5)
 *
 * "Something changed? Suggest a fix" waits here too, `kind` 'fix', `post_id` the page: the whole page as the member would
 * have it (any field not sent is the page's own as it shows), "What changed?" (`note`, required, 300), and `fix_base`: each
 * part the member changed, with what the page said when they sent it (a part sent as the page has it is no change; the
 * note alone changes none). The writer's own fix waits too; an owner or admin edits at once instead (409 `edit_instead`).
 * One waiting fix per member per page; the same 3 waiting and 5 a day as a new page. A fix never brings photos: the page
 * keeps its own. Its tags are a part as its words are (FIX_PARTS): a fix that changes only the tags is a fix. The page stays
 * as it is until an owner or admin answers. Approving writes only the parts the member changed, over the page as it shows then (with any "Edit first" edits), so another fix approved meanwhile, or an owner's or
 * admin's own edit, stays; it keeps the writer, stamps Checked and clears a "may be out of date" mark (engine/knowledge.ts
 * rewriteKnowledge, the same write as their own edit). A part the page itself changed under since the fix was sent is never
 * written over: the approval is refused (409 `page_changed`) until "Edit first" sends that part, or "Not this one" answers
 * it. The member is told "Your fix is in" or "Your fix wasn't used".
 *
 * ## Who
 *
 * An active member suggests, not while muted, within a new account's limits as for posting (engine/probation.ts), with a
 * name and a face as for posting. An owner's or admin's own page publishes at once instead (409 `publish_instead`). Owners
 * and admins list, read, approve (with edits, "Edit first") and say no with a reason from the short list; a moderator or a
 * member is refused (403 `admins_only`). An assistant's draft (slice K6) waits here too, `via` 'assistant:<grant id>', for
 * the owner or admin it acts for: approving one waits for the tick "I opened the sources and they say this.", the page is
 * the approver's (they stand behind it) and is marked `created_via` 'assistant-draft:<grant id>', a mark the assistant's
 * own post tools never match (they match 'assistant:').
 *
 * ## Limits
 *
 * KNOWLEDGE_DRAFT_LIMITS: 3 waiting and 5 sent in any 24 hours, both read from the rows. A taken-back suggestion keeps its
 * row, its words blanked, so it still counts for the day; an answered or taken-back row is deleted 30 days after, with a
 * tombstone (tidyKnowledgeDrafts, hourly, main server only). A waiting one stays: its member holds at most 3.
 *
 * ## Photos
 *
 * The sender's own, at most 3, checked as a page's are and stripped of their metadata on the way in, kept in the row as a
 * data URL: never in the image store and never under posts/, so no post's photo route serves one, and a standby's copy
 * carries them whole. Charged to the sender's photo budget once, when sent; approval stores them as the page's own photos
 * without charging them again; answered or taken back, they are deleted with their tombstones.
 *
 * ## Who is told
 *
 * Owners and admins: one push per member's suggestion (`community.knowledge`; its details name who and what). None for an
 * assistant's draft: the admin asked for it. The member: at the answer, a kept notice (engine/kept-notices.ts) and a push
 * (`community.knowledge-answer`): the page's title, the reason's label and the admin's own words, never who answered. Nothing about
 * a suggestion goes to a socket, and no log line holds its words.
 *
 * Every write here refuses on a standby (assertPlainTablesWritable); none is a ledger write.
 */
import crypto from 'node:crypto';
import {
    KNOWLEDGE_DECLINE_REASONS, KNOWLEDGE_DRAFT_LIMITS, KNOWLEDGE_FIX_PARTS, KNOWLEDGE_LIMITS, freeTagsOf, knowledgeAnswerNotice, storedFreeTags, word, wordsFor,
    type KnowledgeDeclineReason, type KnowledgeDraftKind, type KnowledgeDraftMine, type KnowledgeDraftToCheck, type KnowledgeDraftWhole,
    type KnowledgeFixPart, type KnowledgePageWords, type KnowledgeSource,
} from '@beanpool/core';
import { getMember, validatePostPhotos, type MarketplacePost } from '@beanpool/engine';
import { db, deletePlainRows } from '../db/db.js';
import { assertFeatureOn, getProfileSwitches } from '../config/node-profile.js';
import { assertPlainTablesWritable } from '../config/node-role.js';
import { cleanMemberText } from '../agent/fence.js';
import { stripImageValue } from '../storage/image-metadata.js';
import { getNodeRole } from './sync.js';
import { assertNotMuted } from './auto-moderation.js';
import { assertMayPost } from './probation.js';
import { assertProfileComplete, POST_PHOTO_FORMAT_ERROR } from './posts.js';
import { photoRefusalError, photosRefusal } from './avatar.js';
import { assertMayStorePhotoBytes, incomingPhotosBytes, recordStoredPhotoBytes } from './photo-upload-budget.js';
import { keepNotice } from './kept-notices.js';
import {
    KNOWLEDGE_WORDS, KnowledgeRefusal, checksKnowledge, cleanKnowledgeInput, pageShowingTo, publishKnowledge, recountKnowledgeHelped, rewriteKnowledge,
    showingKnowledgeRow, type CleanKnowledge, type KnowledgeInput, type ShowingKnowledgeRow,
} from './knowledge.js';
import { logger } from '../logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
// A refusal with a value in it, in English as a template wrote it, its sentence marked for the way out to find again in the
// member's language (member-words.ts); and the English the node keeps a notice in.
const EN = wordsFor('en');
const tr = EN.t;

/** How a kept notice says it is a suggestion's answer (engine/kept-notices.ts `data.kind`). */
export const KNOWLEDGE_NOTICE_KIND = 'knowledge_draft';

type BroadcastFn = (event: any, recipients?: string[], opts?: { listingParties?: string[] }) => void;

export const DRAFT_WORDS = {
    publishInstead: word('You’re an owner or admin here, so your own page goes into Learn at once: publish it instead.'),
    notWaiting: word('This suggestion isn’t waiting any more: it was answered or taken back.'),
    alreadyAnswered: word('This one was already answered.'),
    writerPaused: word('This member’s account is paused, so it can’t be added now.'),
    tickSources: word('Tick “I opened the sources and they say this.” first.'),
    membersPhotos: word('A member’s suggestion keeps its own photos: you can leave one out, not add one.'),
    editInstead: word('You’re an owner or admin here, so you change a page at once: edit it instead.'),
    fixWaiting: word('You’ve already suggested a fix to this page. Wait for an answer, or take it back.'),
    noNote: word('Say what changed.'),
    fixPhotos: word('A fix changes the words: the page keeps its own photos.'),
    pageChanged: word('This page has changed since the fix was sent. Choose the words with “Edit first”, or say “Not this one”.'),
} as const;

interface DraftRow {
    id: string;
    kind: KnowledgeDraftKind;
    post_id: string | null;
    member_pubkey: string;
    via: string;
    assistant_name: string | null;
    title: string;
    body: string;
    topic: string;
    place: string | null;
    sources: string | null;
    lang: string | null;
    /** Its own tags: a JSON list in their stored form, '' for none, as a page's `posts.free_tags`. */
    free_tags: string;
    about: string | null;
    note: string | null;
    /** A fix's parts its member changed, with what the page said when they sent it: JSON `{ part: value }`. NULL for a new page. */
    fix_base: string | null;
    state: 'waiting' | 'approved' | 'declined' | 'withdrawn';
    answered_at: string | null;
    answered_by: string | null;
    reason: string | null;
    reason_words: string | null;
    result_post_id: string | null;
    created_at: string;
}

/** The assistant's grant id of an assistant's draft (`assistant:<grant id>`), or null for a member's from the app. */
function assistantGrantOf(via: string): string | null {
    return via.startsWith('assistant:') ? via.slice('assistant:'.length) : null;
}

function sourcesOf(raw: string | null): KnowledgeSource[] {
    try {
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list.filter((s): s is KnowledgeSource => !!s && typeof s.url === 'string').map((s) => ({ url: s.url, label: typeof s.label === 'string' ? s.label : '' })) : [];
    } catch {
        return [];
    }
}

/** A suggestion as its member reads it. Never a taken-back one: those are listed nowhere. */
const mineOf = (r: DraftRow & { state: KnowledgeDraftMine['state'] }): KnowledgeDraftMine => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    topic: r.topic,
    state: r.state,
    createdAt: r.created_at,
    answeredAt: r.answered_at,
    postId: r.state === 'approved' ? r.result_post_id : null,
    fixOf: r.kind === 'fix' ? r.post_id : null,
    reason: r.state === 'declined' && KNOWLEDGE_DECLINE_REASONS.some((x) => x.id === r.reason) ? r.reason as KnowledgeDeclineReason : null,
    reasonWords: r.state === 'declined' ? r.reason_words : null,
});

/** A member who can have a page here now: an active member's row, not a visitor's. */
const STANDING_SQL = `SELECT 1 FROM members WHERE public_key = ? AND status = 'active' AND COALESCE(is_visitor, 0) = 0`;
const inStanding = (pk: string) => !!db.prepare(STANDING_SQL).get(pk);

// ── The member ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The photos a suggestion brings: data URLs only (new bytes, the sender's own), at most 3, held to a page's rules
 * (validatePostPhotos and the format, pixel and strip checks createPost's photos pass), then stripped of their metadata.
 */
function draftPhotos(raw: unknown): string[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.some((p) => typeof p !== 'string' || !/^data:/i.test(p.trim()))) {
        throw new KnowledgeRefusal(400, 'bad_photos', KNOWLEDGE_WORDS.photos);
    }
    if (raw.length > KNOWLEDGE_LIMITS.photos) throw new KnowledgeRefusal(400, 'too_many_photos', tr('At most {n} photos.', { n: KNOWLEDGE_LIMITS.photos }));
    const photos = (raw as string[]).map((p) => p.trim());
    validatePostPhotos(photos);
    const refusal = photosRefusal(photos);
    if (refusal) throw photoRefusalError(refusal, POST_PHOTO_FORMAT_ERROR);
    return photos.map((p) => stripImageValue(p));
}

const waitingCount = (member: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM knowledge_drafts WHERE member_pubkey = ? AND via = 'app' AND state = 'waiting'`).get(member) as { n: number }).n;
const sentSince = (member: string, since: number) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM knowledge_drafts WHERE member_pubkey = ? AND via = 'app' AND created_at > ?`).get(member, iso(since)) as { n: number }).n;

/**
 * A member suggests a new page (§3.3): it waits for an owner or admin. Refused, in the words the form shows: an owner or
 * admin (theirs publishes at once), muted, over a new account's limits, no name or face, 3 waiting, 5 sent today, a field
 * the form holds to its limits, a photo that isn't one. Returns the suggestion as My suggestions lists it.
 */
export function suggestKnowledge(member: string, raw: KnowledgeInput & { photos?: unknown; fixOf?: unknown; note?: unknown }, now = Date.now()): KnowledgeDraftMine {
    assertPlainTablesWritable();
    assertFeatureOn('knowledge');
    if (raw.fixOf !== undefined) return suggestKnowledgeFix(member, raw, now);
    if (checksKnowledge(member)) throw new KnowledgeRefusal(409, 'publish_instead', DRAFT_WORDS.publishInstead);
    assertNotMuted(member, now);
    assertDraftRoom(member, now);
    const k = cleanKnowledgeInput(raw);
    const photos = draftPhotos(raw.photos);
    assertMayPost(member, photos.length, now);
    assertProfileComplete(member);
    const bytes = incomingPhotosBytes(photos);
    assertMayStorePhotoBytes(member, bytes, now);
    const id = crypto.randomUUID();
    const at = iso(now);
    db.transaction(() => {
        db.prepare(`INSERT INTO knowledge_drafts (id, kind, post_id, member_pubkey, via, title, body, topic, place, sources, lang, free_tags, state, created_at)
                    VALUES (?, 'new', NULL, ?, 'app', ?, ?, ?, ?, ?, ?, ?, 'waiting', ?)`)
            .run(id, member, k.title, k.body, k.topic, k.place, k.sources.length > 0 ? JSON.stringify(k.sources) : null, k.lang, storedFreeTags(k.freeTags), at);
        const photo = db.prepare('INSERT INTO knowledge_draft_photos (draft_id, order_num, photo_data, bytes) VALUES (?, ?, ?, ?)');
        photos.forEach((p, i) => photo.run(id, i, p, incomingPhotosBytes([p])));
    })();
    recordStoredPhotoBytes(member, bytes, now);
    return mineOf(db.prepare('SELECT * FROM knowledge_drafts WHERE id = ?').get(id) as DraftRow & { state: 'waiting' });
}

/** A member's room for one more suggestion, new or a fix: 3 waiting, 5 sent in any 24 hours (taken back or not). */
function assertDraftRoom(member: string, now: number): void {
    if (waitingCount(member) >= KNOWLEDGE_DRAFT_LIMITS.waiting) {
        throw new KnowledgeRefusal(429, 'too_many_waiting', tr('You have {n} waiting already. Wait for an answer, or take one back.', { n: KNOWLEDGE_DRAFT_LIMITS.waiting }));
    }
    if (sentSince(member, now - DAY_MS) >= KNOWLEDGE_DRAFT_LIMITS.perDay) {
        throw new KnowledgeRefusal(429, 'sent_enough_today', tr('You’ve sent {n} today. Try again tomorrow.', { n: KNOWLEDGE_DRAFT_LIMITS.perDay }));
    }
}

/** A fix's "What changed?" (§3.5): one line, required, at most KNOWLEDGE_LIMITS.changeNote characters. */
function changeNote(raw: unknown): string {
    const note = cleanMemberText(typeof raw === 'string' ? raw : '', KNOWLEDGE_LIMITS.changeNote * 4).replace(/\s+/g, ' ').trim();
    if (!note) throw new KnowledgeRefusal(400, 'no_note', DRAFT_WORDS.noNote);
    if (Array.from(note).length > KNOWLEDGE_LIMITS.changeNote) {
        throw new KnowledgeRefusal(400, 'too_long', tr('Keep what changed to {n} characters.', { n: KNOWLEDGE_LIMITS.changeNote }));
    }
    return note;
}

/**
 * "Something changed? Suggest a fix" (§3.5): a member, the page's writer included, sends the page as they would have it and
 * what changed; it waits for an owner or admin, and the page stays as it is meanwhile. Any field not sent is the page's own
 * as it shows, so "the note alone" is a fix. Refused: an owner or admin (they edit at once), muted, a page this member
 * can't read now (404), no note, photos (the page keeps its own), a fix of theirs to this page already waiting, the limits a
 * new page has, a field over its limit, no name or face.
 */
function suggestKnowledgeFix(member: string, raw: KnowledgeInput & { photos?: unknown; fixOf?: unknown; note?: unknown }, now: number): KnowledgeDraftMine {
    if (checksKnowledge(member)) throw new KnowledgeRefusal(409, 'edit_instead', DRAFT_WORDS.editInstead);
    assertNotMuted(member, now);
    const page = pageShowingTo(member, raw.fixOf);
    if (!page) throw new KnowledgeRefusal(404, 'not_found', KNOWLEDGE_WORDS.notFound);
    if (raw.photos !== undefined && raw.photos !== null && !(Array.isArray(raw.photos) && raw.photos.length === 0)) {
        throw new KnowledgeRefusal(400, 'fix_photos', DRAFT_WORDS.fixPhotos);
    }
    const note = changeNote(raw.note);
    if (db.prepare(`SELECT 1 FROM knowledge_drafts WHERE member_pubkey = ? AND via = 'app' AND kind = 'fix' AND post_id = ? AND state = 'waiting'`).get(member, page.id)) {
        throw new KnowledgeRefusal(409, 'fix_waiting', DRAFT_WORDS.fixWaiting);
    }
    assertDraftRoom(member, now);
    const row = showingKnowledgeRow(page.id);
    if (!row) throw new KnowledgeRefusal(404, 'not_found', KNOWLEDGE_WORDS.notFound);
    const shows = partsOf(row);
    const own = cleanKnowledgeInput(shows, shows.freeTags);
    const pick = (sent: unknown, mine: unknown) => (sent !== undefined ? sent : mine);
    const k = cleanKnowledgeInput({
        title: pick(raw.title, own.title),
        body: pick(raw.body, own.body),
        topic: pick(raw.topic, own.topic),
        place: pick(raw.place, own.place),
        sources: pick(raw.sources, own.sources),
        lang: pick(raw.lang, own.lang),
        freeTags: pick(raw.freeTags, own.freeTags),
        tags: raw.tags,
    }, shows.freeTags);
    // What the member changed: each part that differs from the page as it shows, with the page's own words then. A part sent
    // as the page has it (the app may send the form whole) is no change.
    const base: Partial<Record<FixPart, unknown>> = {};
    for (const part of FIX_PARTS) if (!samePart(k[part], own[part])) base[part] = shows[part];
    assertMayPost(member, 0, now);
    assertProfileComplete(member);
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO knowledge_drafts (id, kind, post_id, member_pubkey, via, title, body, topic, place, sources, lang, free_tags, note, fix_base, state, created_at)
                VALUES (?, 'fix', ?, ?, 'app', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?)`)
        .run(id, page.id, member, k.title, k.body, k.topic, k.place, k.sources.length > 0 ? JSON.stringify(k.sources) : null, k.lang,
            storedFreeTags(k.freeTags), note, JSON.stringify(base), iso(now));
    return mineOf(db.prepare('SELECT * FROM knowledge_drafts WHERE id = ?').get(id) as DraftRow & { state: 'waiting' });
}

/** A page's words and tags as its row holds them, part by part (they were cleaned when written). */
const partsOf = (row: ShowingKnowledgeRow): CleanKnowledge => ({
    title: row.title,
    body: row.description,
    topic: row.category,
    place: row.knowledge_place,
    sources: sourcesOf(row.knowledge_sources),
    lang: row.knowledge_lang,
    freeTags: freeTagsOf(row.free_tags),
});

/** A suggestion's words and tags as its row holds them. */
const draftWordsOf = (r: DraftRow): CleanKnowledge => ({
    title: r.title, body: r.body, topic: r.topic, place: r.place, sources: sourcesOf(r.sources), lang: r.lang, freeTags: freeTagsOf(r.free_tags),
});

/**
 * The parts a fix can change, here: core's KNOWLEDGE_FIX_PARTS (the words, which the apps draw as "Now" and "Suggested") and
 * the page's tags. `fix_base` records each, and approval writes each, alike; To check sends the tags' change beside the
 * words' (freeTagsChanged, freeTagsPageChanged) so an app from before Learn's tags reads the parts it knows.
 */
const FIX_PARTS = [...KNOWLEDGE_FIX_PARTS, 'freeTags'] as const;
type FixPart = (typeof FIX_PARTS)[number];

const samePart = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** A fix's recorded base (`fix_base`): its changed parts, each with the page's words when it was sent. */
function fixBaseOf(raw: string | null): Partial<Record<FixPart, unknown>> {
    try {
        const base = raw ? JSON.parse(raw) : {};
        return base && typeof base === 'object' && !Array.isArray(base) ? base : {};
    } catch {
        return {};
    }
}

const changedPartsOf = (r: DraftRow): FixPart[] => {
    const base = fixBaseOf(r.fix_base);
    return FIX_PARTS.filter((part) => Object.prototype.hasOwnProperty.call(base, part));
};

/** The word parts of a list of a fix's parts, as core's KnowledgeFixPart names them (the tags go beside them). */
const wordParts = (parts: readonly FixPart[]): KnowledgeFixPart[] => parts.filter((part): part is KnowledgeFixPart => part !== 'freeTags');

/**
 * A fix against the page as it shows now: the parts its member changed; those the page itself changed under since it was
 * sent (neither the page's words then nor the fix's own); and the page as Approve writes it, the page as it shows with
 * the changed parts put in.
 */
function fixAgainst(r: DraftRow, page: ShowingKnowledgeRow): { changed: FixPart[]; pageChanged: FixPart[]; suggested: CleanKnowledge } {
    const base = fixBaseOf(r.fix_base);
    const shows = partsOf(page);
    const mine = draftWordsOf(r);
    const changed = changedPartsOf(r);
    const pageChanged = changed.filter((part) => !samePart(shows[part], base[part]) && !samePart(shows[part], mine[part]));
    const suggested: CleanKnowledge = { ...shows };
    for (const part of changed) (suggested as unknown as Record<string, unknown>)[part] = mine[part];
    return { changed, pageChanged, suggested };
}

/**
 * The member's own (§3.4): what waits, newest first, then the answers of the last 30 days, the latest first. A taken-back
 * one is listed nowhere.
 */
export function myKnowledgeDrafts(member: string, now = Date.now()): { waiting: KnowledgeDraftMine[]; answered: KnowledgeDraftMine[] } {
    const waiting = db.prepare(`SELECT * FROM knowledge_drafts WHERE member_pubkey = ? AND via = 'app' AND state = 'waiting'
                                ORDER BY created_at DESC, id DESC`).all(member) as (DraftRow & { state: 'waiting' })[];
    const answered = db.prepare(`SELECT * FROM knowledge_drafts WHERE member_pubkey = ? AND via = 'app' AND state IN ('approved', 'declined')
                                 AND answered_at >= ? ORDER BY answered_at DESC, id DESC`)
        .all(member, iso(now - KNOWLEDGE_DRAFT_LIMITS.answeredDays * DAY_MS)) as (DraftRow & { state: 'approved' | 'declined' })[];
    return { waiting: waiting.map(mineOf), answered: answered.map(mineOf) };
}

/**
 * "Take it back" (§3.4): the member's own waiting suggestion leaves the list at once. Its words are blanked and its photos
 * deleted, each with a tombstone; the row stays 30 days only so it counts for the day. Someone else's, or one already
 * answered, reads as none (false).
 */
export function withdrawKnowledgeDraft(member: string, id: unknown, now = Date.now()): boolean {
    assertPlainTablesWritable();
    if (typeof id !== 'string' || id.length > 64) return false;
    return db.transaction(() => {
        const changed = db.prepare(`UPDATE knowledge_drafts SET state = 'withdrawn', answered_at = ?, title = '', body = '', place = NULL,
                                        sources = NULL, free_tags = '', note = NULL, about = NULL, fix_base = NULL
                                    WHERE id = ? AND member_pubkey = ? AND via = 'app' AND state = 'waiting'`).run(iso(now), id, member).changes;
        if (changed === 1) deletePlainRows('knowledge_draft_photos', 'draft_id = ?', id);
        return changed === 1;
    })();
}

// ── An owner's or admin's assistant (slice K6; agent/knowledge.ts) ─────────────────────────────────────────────────

/**
 * What an assistant may have waiting (§2.4): 10 waiting and 20 sent in any 24 hours per connection, and 30 waiting from all
 * assistants together, so members' suggestions (their own limits, `via` 'app') are never buried. Read from the rows, so a
 * restart keeps them; a draft taken back still counts for the day, as a member's does.
 */
export const ASSISTANT_KNOWLEDGE_LIMITS = Object.freeze({ waiting: 10, perDay: 20, allWaiting: 30 });

/** What an assistant says a draft is about (§6): a place, a service or how to do something. Never a person. */
export const KNOWLEDGE_ABOUT = ['place', 'service', 'how_to'] as const;
export type KnowledgeAbout = (typeof KNOWLEDGE_ABOUT)[number];

/** The words an assistant reads when a draft is refused: MCP tool text, outside the members' word index. */
export const ASSISTANT_DRAFT_WORDS = {
    noSource: 'Local knowledge from the web needs at least one source link.',
    notAbout: 'Local knowledge is about places, services and how to do things, never about a private person.',
    waiting: `This assistant has ${ASSISTANT_KNOWLEDGE_LIMITS.waiting} drafts of Local knowledge waiting, the most it may: wait until an owner or admin answers them, or take one back with knowledge_draft_withdraw.`,
    perDay: `This assistant has filed ${ASSISTANT_KNOWLEDGE_LIMITS.perDay} drafts of Local knowledge in the last 24 hours, the most it may: try again later.`,
    allWaiting: `Assistants have ${ASSISTANT_KNOWLEDGE_LIMITS.allWaiting} drafts of Local knowledge waiting here, the most there may be: wait until an owner or admin answers some.`,
} as const;

const viaOf = (grantId: string) => `assistant:${grantId}`;

/** This connection's drafts waiting now, and sent in the last 24 hours (taken back or answered, still counted). */
export function assistantKnowledgeCounts(grantId: string, now = Date.now()): { waiting: number; today: number } {
    const via = viaOf(grantId);
    const waiting = (db.prepare(`SELECT COUNT(*) AS n FROM knowledge_drafts WHERE via = ? AND state = 'waiting'`).get(via) as { n: number }).n;
    const today = (db.prepare(`SELECT COUNT(*) AS n FROM knowledge_drafts WHERE via = ? AND created_at > ?`).get(via, iso(now - DAY_MS)) as { n: number }).n;
    return { waiting, today };
}

/**
 * An assistant files a draft (§6 knowledge_draft): it waits in To check for an owner or admin, for the member it acts for, and
 * nothing shows to anyone until a person approves it (approveKnowledgeDraft: the tick, then the approver's page marked
 * `assistant-draft:<grant>`). Its words are cleaned as a member's are (cleanKnowledgeInput: hidden characters out, markers
 * defused, plain text). At least one source; `about` one of KNOWLEDGE_ABOUT; no photo (the caller refuses the field). No push
 * goes to the owners and admins: the one it acts for asked for it. The limits are checked in the same transaction as the write.
 */
export function fileAssistantKnowledgeDraft(
    grant: { id: string; member: string; name: string },
    raw: KnowledgeInput & { about?: unknown },
    now = Date.now(),
): { id: string; waiting: number; today: number } {
    assertPlainTablesWritable();
    assertFeatureOn('knowledge');
    if (typeof raw.about !== 'string' || !(KNOWLEDGE_ABOUT as readonly string[]).includes(raw.about)) {
        throw new KnowledgeRefusal(400, 'not_about', ASSISTANT_DRAFT_WORDS.notAbout);
    }
    if (!Array.isArray(raw.sources) || raw.sources.length === 0) throw new KnowledgeRefusal(400, 'no_source', ASSISTANT_DRAFT_WORDS.noSource);
    const k = cleanKnowledgeInput(raw);
    const id = crypto.randomUUID();
    const via = viaOf(grant.id);
    db.transaction(() => {
        const counts = assistantKnowledgeCounts(grant.id, now);
        if (counts.waiting >= ASSISTANT_KNOWLEDGE_LIMITS.waiting) throw new KnowledgeRefusal(429, 'too_many_waiting', ASSISTANT_DRAFT_WORDS.waiting);
        if (counts.today >= ASSISTANT_KNOWLEDGE_LIMITS.perDay) throw new KnowledgeRefusal(429, 'sent_enough_today', ASSISTANT_DRAFT_WORDS.perDay);
        const all = (db.prepare(`SELECT COUNT(*) AS n FROM knowledge_drafts WHERE via LIKE 'assistant:%' AND state = 'waiting'`).get() as { n: number }).n;
        if (all >= ASSISTANT_KNOWLEDGE_LIMITS.allWaiting) throw new KnowledgeRefusal(429, 'assistants_waiting', ASSISTANT_DRAFT_WORDS.allWaiting);
        db.prepare(`INSERT INTO knowledge_drafts (id, kind, post_id, member_pubkey, via, assistant_name, title, body, topic, place, sources, lang, free_tags, about, state, created_at)
                    VALUES (?, 'new', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?)`)
            .run(id, grant.member, via, cleanMemberText(grant.name, 60) || null, k.title, k.body, k.topic, k.place,
                JSON.stringify(k.sources), k.lang, storedFreeTags(k.freeTags), raw.about, iso(now));
    })();
    return { id, ...assistantKnowledgeCounts(grant.id, now) };
}

/** One of an assistant's own drafts as it reads it back (§6 my_knowledge_drafts): never who answered, never their words. */
export interface AssistantDraftView {
    id: string;
    kind: KnowledgeDraftKind;
    topic: string;
    title: string;
    state: 'waiting' | 'added' | 'not_added';
    createdAt: string;
    answeredAt: string | null;
    postId: string | null;
    reason: KnowledgeDeclineReason | null;
}

/** This connection's drafts, newest first: waiting, added (the page's id) or not added (the reason's id). Taken back: none. */
export function assistantKnowledgeDrafts(grantId: string, limit: number): { drafts: AssistantDraftView[]; total: number } {
    const where = `via = ? AND state IN ('waiting', 'approved', 'declined')`;
    const rows = db.prepare(`SELECT * FROM knowledge_drafts WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`).all(viaOf(grantId), limit) as DraftRow[];
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM knowledge_drafts WHERE ${where}`).get(viaOf(grantId)) as { n: number }).n;
    return {
        total,
        drafts: rows.map((r) => ({
            id: r.id,
            kind: r.kind,
            topic: r.topic,
            title: r.title,
            state: r.state === 'approved' ? 'added' : r.state === 'declined' ? 'not_added' : 'waiting',
            createdAt: r.created_at,
            answeredAt: r.answered_at,
            postId: r.state === 'approved' ? r.result_post_id : null,
            reason: r.state === 'declined' && KNOWLEDGE_DECLINE_REASONS.some((x) => x.id === r.reason) ? r.reason as KnowledgeDeclineReason : null,
        })),
    };
}

/**
 * An assistant takes back one of its own waiting drafts (§6 knowledge_draft_withdraw): as a member's "Take it back", the words
 * are blanked and the row stays 30 days only so it counts for the day. Another connection's, or one answered: false.
 */
export function withdrawAssistantKnowledgeDraft(grantId: string, id: unknown, now = Date.now()): boolean {
    assertPlainTablesWritable();
    if (typeof id !== 'string' || id.length > 64) return false;
    return db.transaction(() => {
        const changed = db.prepare(`UPDATE knowledge_drafts SET state = 'withdrawn', answered_at = ?, title = '', body = '', place = NULL,
                                        sources = NULL, free_tags = '', note = NULL, about = NULL, fix_base = NULL
                                    WHERE id = ? AND via = ? AND state = 'waiting'`).run(iso(now), id, viaOf(grantId)).changes;
        if (changed === 1) deletePlainRows('knowledge_draft_photos', 'draft_id = ?', id);
        return changed === 1;
    })();
}

/**
 * Disconnecting an assistant drops its waiting drafts (§6), each with its tombstone; what a person approved stays, and so do
 * the answered rows (the tidy-up takes them at 30 days). Called beside agent/suggestions.ts dropSuggestionsOf wherever a grant
 * goes: Settings' Disconnect, a token's Revoke, and an OAuth grant revoked by its reuse, its replacement or itself.
 */
export function dropAssistantKnowledgeDrafts(grantId: string): number {
    if (getNodeRole() !== 'primary') return 0;
    return db.transaction(() => {
        const where = `via = ? AND state = 'waiting'`;
        deletePlainRows('knowledge_draft_photos', `draft_id IN (SELECT id FROM knowledge_drafts WHERE ${where})`, viaOf(grantId));
        return deletePlainRows('knowledge_drafts', where, viaOf(grantId));
    })();
}

// ── The owners and admins ──────────────────────────────────────────────────────────────────────────────────────────

/** How many suggestions wait for an owner or admin: 0 where Learn is off. For the admin queue and Needs you. */
export function knowledgeDraftCount(): number {
    if (!getProfileSwitches().knowledge) return 0;
    return (db.prepare(`SELECT COUNT(*) AS n FROM knowledge_drafts WHERE state = 'waiting'`).get() as { n: number }).n;
}

const nameOf = (pk: string) => getMember(db, pk)?.callsign ?? '';

const toCheckOf = (r: DraftRow): KnowledgeDraftToCheck => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    topic: r.topic,
    from: { pubkey: r.member_pubkey, name: nameOf(r.member_pubkey) },
    assistant: assistantGrantOf(r.via) !== null ? (r.assistant_name ?? '') : null,
    createdAt: r.created_at,
});

/** To check (§5.2): every waiting suggestion, the longest waiting first. */
export function knowledgeDraftsToCheck(limit: number, offset: number): { drafts: KnowledgeDraftToCheck[]; total: number } {
    const rows = db.prepare(`SELECT * FROM knowledge_drafts WHERE state = 'waiting' ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?`)
        .all(limit, offset) as DraftRow[];
    // A fix's row names the page as it shows, as its push and its notices do, not the title it suggests.
    const named = (r: DraftRow) => (r.kind === 'fix' ? { ...toCheckOf(r), title: showingKnowledgeRow(r.post_id)?.title ?? r.title } : toCheckOf(r));
    return { drafts: rows.map(named), total: knowledgeDraftCountAll() };
}

const knowledgeDraftCountAll = () => (db.prepare(`SELECT COUNT(*) AS n FROM knowledge_drafts WHERE state = 'waiting'`).get() as { n: number }).n;

/** One waiting suggestion whole, as the checking screen shows it (§5.3), its photos included; null when none waits. */
export function knowledgeDraftWhole(id: unknown): KnowledgeDraftWhole | null {
    if (typeof id !== 'string' || id.length > 64) return null;
    const r = db.prepare(`SELECT * FROM knowledge_drafts WHERE id = ? AND state = 'waiting'`).get(id) as DraftRow | undefined;
    if (!r) return null;
    const page = r.kind === 'fix' ? showingKnowledgeRow(r.post_id) : null;
    // A fix whose page shows: "Suggested" is what Approve writes, the page as it shows with the member's changed parts put in.
    const fix = page ? fixAgainst(r, page) : null;
    const words = fix?.suggested ?? draftWordsOf(r);
    const changed = r.kind === 'fix' ? (fix?.changed ?? changedPartsOf(r)) : null;
    const pageChanged = r.kind === 'fix' ? (fix?.pageChanged ?? []) : null;
    return {
        ...toCheckOf(r),
        title: words.title,
        topic: words.topic,
        body: words.body,
        place: words.place,
        sources: words.sources,
        lang: words.lang,
        about: r.about,
        note: r.note,
        photos: draftPhotoData(r.id),
        needsSourcesTicked: assistantGrantOf(r.via) !== null,
        post: pageWordsOf(page),
        changed: changed && wordParts(changed),
        pageChanged: pageChanged && wordParts(pageChanged),
        freeTags: words.freeTags,
        freeTagsChanged: changed && changed.includes('freeTags'),
        freeTagsPageChanged: pageChanged && pageChanged.includes('freeTags'),
    };
}

/** A page's words as it shows, for "Now" beside a fix's "Suggested"; null when it isn't showing. */
const pageWordsOf = (row: ShowingKnowledgeRow | null): KnowledgePageWords | null => (row ? {
    id: row.id,
    title: row.title,
    body: row.description,
    topic: row.category,
    place: row.knowledge_place,
    sources: sourcesOf(row.knowledge_sources),
    lang: row.knowledge_lang,
    freeTags: freeTagsOf(row.free_tags),
} : null);

const draftPhotoData = (id: string): string[] =>
    (db.prepare('SELECT photo_data FROM knowledge_draft_photos WHERE draft_id = ? ORDER BY order_num').all(id) as { photo_data: string }[]).map((p) => p.photo_data);

function assertChecker(key: string): void {
    if (!checksKnowledge(key)) throw new KnowledgeRefusal(403, 'admins_only', KNOWLEDGE_WORDS.adminsOnly);
}

/** The waiting suggestion `id`, or the refusal: none (404), or answered already, by another owner or admin perhaps (409). */
function waitingDraft(id: unknown): DraftRow {
    const r = typeof id === 'string' && id.length <= 64 ? db.prepare('SELECT * FROM knowledge_drafts WHERE id = ?').get(id) as DraftRow | undefined : undefined;
    if (!r || r.state === 'withdrawn') throw new KnowledgeRefusal(404, 'not_found', DRAFT_WORDS.notWaiting);
    if (r.state !== 'waiting') throw new KnowledgeRefusal(409, 'already_answered', DRAFT_WORDS.alreadyAnswered);
    return r;
}

/**
 * A member's photos at approval: all of theirs, or, when "Edit first" sends `photos`, the ones it sends back, each one of
 * theirs exactly as read (GET /api/knowledge/drafts/:id), in the order sent. Never a photo that isn't theirs.
 */
function keptPhotos(draftId: string, sent: unknown): string[] {
    const own = draftPhotoData(draftId);
    if (sent === undefined || sent === null) return own;
    if (!Array.isArray(sent) || sent.some((p) => typeof p !== 'string' || !own.includes(p))) {
        throw new KnowledgeRefusal(400, 'bad_photos', DRAFT_WORDS.membersPhotos);
    }
    return [...new Set(sent as string[])];
}

/** The page's fields at approval: each one the request sends ("Edit first"), the suggestion's own for the rest. */
function approvedFields(r: DraftRow, raw: KnowledgeInput): KnowledgeInput {
    const pick = (sent: unknown, own: unknown) => (sent !== undefined ? sent : own);
    return {
        title: pick(raw.title, r.title),
        body: pick(raw.body, r.body),
        topic: pick(raw.topic, r.topic),
        place: pick(raw.place, r.place),
        sources: pick(raw.sources, sourcesOf(r.sources)),
        lang: pick(raw.lang, r.lang),
        freeTags: pick(raw.freeTags, freeTagsOf(r.free_tags)),
        tags: raw.tags,
    };
}

/**
 * The member's kept copy of an answer, in English (core knowledgeAnswerNotice), and the words the route's push carries; null
 * for an assistant's draft, whose owner or admin reads how it ended through their assistant (K6), not the bell.
 */
function keepAnswer(r: DraftRow, answer: Parameters<typeof knowledgeAnswerNotice>[0], data: Record<string, unknown>, now: number): KnowledgeAnswer['notice'] {
    if (assistantGrantOf(r.via) !== null) return null;
    const words = knowledgeAnswerNotice({ ...answer, kind: r.kind }, EN);
    const body = fitNotice(words.body);
    return { id: keepNotice(r.member_pubkey, words.title, body, { kind: KNOWLEDGE_NOTICE_KIND, draftId: r.id, ...data }, now), title: words.title, body };
}

/** A notice's body within what a kept notice holds (400 characters): a long title and the admin's 200 words can pass it. */
function fitNotice(body: string): string {
    if (body.length <= 400) return body;
    let out = '';
    for (const ch of Array.from(body)) {
        if (out.length + ch.length > 399) break;
        out += ch;
    }
    return `${out}…`;
}

export interface KnowledgeAnswer {
    member: string;
    draftId: string;
    /**
     * What the member is told (a member's suggestion from the app): their kept copy's id (null when it couldn't be kept)
     * and its words, which the route's push carries. Null for an assistant's draft.
     */
    notice: { id: string | null; title: string; body: string } | null;
}

/**
 * "Approve" (§5.5): makes the page through publishKnowledge, with any edits the request sends; a member's suggestion with
 * the member as its writer and their photos (charged once, when sent; "Edit first" may leave some out by sending back the
 * ones kept, never add one), an assistant's with the approver as its writer, marked `assistant-draft:<grant id>`, and their
 * own photos if they add some. Checked is stamped. A fix (slice K5) changes the page it names instead (approveFix). In one
 * transaction with the suggestion's answer and its photos' delete, so two owners at once make one page: the second reads
 * "This one was already answered." A member whose account is paused or gone: "This member's account is paused, so it can't
 * be added now."
 */
export function approveKnowledgeDraft(
    broadcast: BroadcastFn,
    checker: string,
    id: unknown,
    raw: KnowledgeInput & { checkedSources?: unknown; photos?: unknown } = {},
    now = Date.now(),
): KnowledgeAnswer & { post: MarketplacePost } {
    assertPlainTablesWritable();
    assertChecker(checker);
    return db.transaction(() => {
        const r = waitingDraft(id);
        const grant = assistantGrantOf(r.via);
        if (grant !== null && raw.checkedSources !== true) throw new KnowledgeRefusal(400, 'sources_not_checked', DRAFT_WORDS.tickSources);
        if (r.kind === 'fix') return approveFix(broadcast, checker, r, raw, now);
        if (grant === null && !inStanding(r.member_pubkey)) throw new KnowledgeRefusal(409, 'writer_paused', DRAFT_WORDS.writerPaused);
        const post = publishKnowledge(broadcast, checker, { ...approvedFields(r, raw), photos: grant === null ? keptPhotos(r.id, raw.photos) : raw.photos }, {
            writer: grant === null ? r.member_pubkey : checker,
            ...(grant === null ? { photosPaidFor: true } : { createdVia: `assistant-draft:${grant}` }),
            now,
        });
        const answered = db.prepare(`UPDATE knowledge_drafts SET state = 'approved', answered_at = ?, answered_by = ?, result_post_id = ?
                                     WHERE id = ? AND state = 'waiting'`).run(iso(now), checker, post.id, r.id).changes;
        if (answered !== 1) throw new Error('a suggestion was answered twice');
        deletePlainRows('knowledge_draft_photos', 'draft_id = ?', r.id);
        const notice = keepAnswer(r, { outcome: 'approved', title: post.title }, { outcome: 'approved', postId: post.id }, now);
        logger.info('ADMIN', 'Local knowledge approved', {
            draft: r.id, post: post.id, by: checker.slice(0, 16), byName: nameOf(checker),
            ...(grant !== null ? { assistant: grant, assistantName: r.assistant_name ?? '' } : {}),
        });
        return { post, member: r.member_pubkey, draftId: r.id, notice };
    })();
}

/**
 * Approving a fix (§3.5, §5.5): the page it names, still showing, takes the parts the member changed over its words as they
 * show now (the checking screen's "Suggested"), with any "Edit first" edits; every other part stays as it shows, so a fix
 * approved meanwhile or an owner's or admin's own edit is kept. A changed part the page itself changed under since the fix
 * was sent is refused, 409 `page_changed`, unless "Edit first" sends that part: never written over without a word. Its
 * writer and photos stay ("Edit first" can't send photos), Checked is stamped and a mark cleared (rewriteKnowledge). A page
 * that stopped showing: 404, and the owner or admin says "Not this one". Inside approveKnowledgeDraft's transaction, so the
 * page read here is the page written.
 */
function approveFix(broadcast: BroadcastFn, checker: string, r: DraftRow, raw: KnowledgeInput & { photos?: unknown }, now: number): KnowledgeAnswer & { post: MarketplacePost } {
    if (raw.photos !== undefined) throw new KnowledgeRefusal(400, 'fix_photos', DRAFT_WORDS.fixPhotos);
    const page = showingKnowledgeRow(r.post_id);
    if (!page) throw new KnowledgeRefusal(404, 'not_found', KNOWLEDGE_WORDS.notFound);
    assertNotMuted(checker, now);
    const fix = fixAgainst(r, page);
    if (fix.pageChanged.some((part) => raw[part] === undefined)) throw new KnowledgeRefusal(409, 'page_changed', DRAFT_WORDS.pageChanged);
    const edited: KnowledgeInput = {};
    for (const part of FIX_PARTS) if (raw[part] !== undefined) edited[part] = raw[part];
    // The page's own tags pass as stored, as on an owner's or admin's edit (engine/knowledge.ts cleanFreeTags).
    const post = rewriteKnowledge(broadcast, checker, page.id, cleanKnowledgeInput({ ...fix.suggested, ...edited, tags: raw.tags }, partsOf(page).freeTags), now);
    const answered = db.prepare(`UPDATE knowledge_drafts SET state = 'approved', answered_at = ?, answered_by = ?, result_post_id = ?
                                 WHERE id = ? AND state = 'waiting'`).run(iso(now), checker, page.id, r.id).changes;
    if (answered !== 1) throw new Error('a suggestion was answered twice');
    const notice = keepAnswer(r, { outcome: 'approved', title: post.title }, { outcome: 'approved', postId: page.id }, now);
    logger.info('ADMIN', 'Local knowledge fix approved', { draft: r.id, post: page.id, by: checker.slice(0, 16), byName: nameOf(checker) });
    return { post, member: r.member_pubkey, draftId: r.id, notice };
}

/**
 * "Not this one" (§5.4): a reason from the short list and, if the owner or admin writes some, their own few words, which the
 * member reads in their notice; never who said it. Its photos go. 409 when another owner or admin answered it first.
 */
export function declineKnowledgeDraft(checker: string, id: unknown, reason: unknown, words: unknown, now = Date.now()): KnowledgeAnswer {
    assertPlainTablesWritable();
    assertChecker(checker);
    if (typeof reason !== 'string' || !KNOWLEDGE_DECLINE_REASONS.some((x) => x.id === reason)) {
        throw new KnowledgeRefusal(400, 'bad_reason', `reason is one of: ${KNOWLEDGE_DECLINE_REASONS.map((x) => x.id).join(', ')}.`);
    }
    const said = cleanMemberText(typeof words === 'string' ? words : '', KNOWLEDGE_LIMITS.reasonWords * 4).replace(/\s+/g, ' ').trim();
    if (Array.from(said).length > KNOWLEDGE_LIMITS.reasonWords) {
        throw new KnowledgeRefusal(400, 'too_long', tr('Keep your words to {n} characters.', { n: KNOWLEDGE_LIMITS.reasonWords }));
    }
    return db.transaction((): KnowledgeAnswer => {
        const r = waitingDraft(id);
        db.prepare(`UPDATE knowledge_drafts SET state = 'declined', answered_at = ?, answered_by = ?, reason = ?, reason_words = ?
                    WHERE id = ? AND state = 'waiting'`).run(iso(now), checker, reason, said || null, r.id);
        deletePlainRows('knowledge_draft_photos', 'draft_id = ?', r.id);
        // A fix's notice names the page as it shows ("Your fix to "{title}" wasn't used"), or the fix's title once it doesn't.
        const title = r.kind === 'fix' ? (showingKnowledgeRow(r.post_id)?.title ?? r.title) : r.title;
        const notice = keepAnswer(r, { outcome: 'declined', title, reason, words: said }, { outcome: 'declined', reason, ...(r.kind === 'fix' ? { postId: r.post_id } : {}) }, now);
        logger.info('ADMIN', 'Local knowledge not added', { draft: r.id, by: checker.slice(0, 16), byName: nameOf(checker), reason });
        return { member: r.member_pubkey, draftId: r.id, notice };
    })();
}

/** The owners and admins a member's suggestion is told to: each an active member's row. */
export function knowledgeCheckers(): string[] {
    return (db.prepare(`SELECT nr.member_pubkey AS pk FROM node_roles nr JOIN members m ON m.public_key = nr.member_pubkey
                        WHERE nr.role IN ('owner', 'admin') AND m.status = 'active' AND m.is_visitor = 0`).all() as { pk: string }[]).map((r) => r.pk);
}

// ── Keeping it tidy ────────────────────────────────────────────────────────────────────────────────────────────────

/** Deletes every answered or taken-back suggestion 30 days after, each with its tombstone. Returns how many went. */
export function tidyKnowledgeDrafts(now = Date.now()): number {
    return deletePlainRows('knowledge_drafts', `state != 'waiting' AND answered_at < ?`, iso(now - KNOWLEDGE_DRAFT_LIMITS.answeredDays * DAY_MS));
}

/**
 * A member removed or gone (a prune, a self-deletion): their suggestions, those photos and their "This helped" taps go, and
 * each page they tapped counts its taps again (slice K5), so its count is the taps that are there.
 */
export function dropKnowledgeOf(pubkey: string): void {
    db.transaction(() => {
        deletePlainRows('knowledge_draft_photos', 'draft_id IN (SELECT id FROM knowledge_drafts WHERE member_pubkey = ?)', pubkey);
        deletePlainRows('knowledge_drafts', 'member_pubkey = ?', pubkey);
        const tapped = (db.prepare('SELECT post_id FROM knowledge_helped WHERE member_pubkey = ?').all(pubkey) as { post_id: string }[]).map((r) => r.post_id);
        deletePlainRows('knowledge_helped', 'member_pubkey = ?', pubkey);
        recountKnowledgeHelped(tapped);
    })();
}

let tidyTimer: ReturnType<typeof setInterval> | null = null;

/** The tidy-up on a timer, on the main server only: a standby takes the deletions from its copy. */
export function startTidyingKnowledgeDrafts(everyMs = 60 * 60 * 1000): void {
    if (tidyTimer) clearInterval(tidyTimer);
    tidyTimer = setInterval(() => {
        if (getNodeRole() !== 'primary') return;
        try { tidyKnowledgeDrafts(); } catch (e) { console.warn('[Local knowledge] could not tidy the waiting list:', (e as Error)?.message || e); }
    }, everyMs);
    tidyTimer.unref?.();
}
