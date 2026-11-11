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
    KNOWLEDGE_DECLINE_REASONS, KNOWLEDGE_DRAFT_LIMITS, KNOWLEDGE_LIMITS, knowledgeAnswerNotice, word, wordsFor,
    type KnowledgeDeclineReason, type KnowledgeDraftKind, type KnowledgeDraftMine, type KnowledgeDraftToCheck, type KnowledgeDraftWhole,
    type KnowledgeSource,
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
import { KNOWLEDGE_WORDS, KnowledgeRefusal, checksKnowledge, publishKnowledge, cleanKnowledgeInput, type KnowledgeInput } from './knowledge.js';
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
    about: string | null;
    note: string | null;
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
export function suggestKnowledge(member: string, raw: KnowledgeInput & { photos?: unknown }, now = Date.now()): KnowledgeDraftMine {
    assertPlainTablesWritable();
    assertFeatureOn('knowledge');
    if (checksKnowledge(member)) throw new KnowledgeRefusal(409, 'publish_instead', DRAFT_WORDS.publishInstead);
    assertNotMuted(member, now);
    if (waitingCount(member) >= KNOWLEDGE_DRAFT_LIMITS.waiting) {
        throw new KnowledgeRefusal(429, 'too_many_waiting', tr('You have {n} waiting already. Wait for an answer, or take one back.', { n: KNOWLEDGE_DRAFT_LIMITS.waiting }));
    }
    if (sentSince(member, now - DAY_MS) >= KNOWLEDGE_DRAFT_LIMITS.perDay) {
        throw new KnowledgeRefusal(429, 'sent_enough_today', tr('You’ve sent {n} today. Try again tomorrow.', { n: KNOWLEDGE_DRAFT_LIMITS.perDay }));
    }
    const k = cleanKnowledgeInput(raw);
    const photos = draftPhotos(raw.photos);
    assertMayPost(member, photos.length, now);
    assertProfileComplete(member);
    const bytes = incomingPhotosBytes(photos);
    assertMayStorePhotoBytes(member, bytes, now);
    const id = crypto.randomUUID();
    const at = iso(now);
    db.transaction(() => {
        db.prepare(`INSERT INTO knowledge_drafts (id, kind, post_id, member_pubkey, via, title, body, topic, place, sources, lang, state, created_at)
                    VALUES (?, 'new', NULL, ?, 'app', ?, ?, ?, ?, ?, ?, 'waiting', ?)`)
            .run(id, member, k.title, k.body, k.topic, k.place, k.sources.length > 0 ? JSON.stringify(k.sources) : null, k.lang, at);
        const photo = db.prepare('INSERT INTO knowledge_draft_photos (draft_id, order_num, photo_data, bytes) VALUES (?, ?, ?, ?)');
        photos.forEach((p, i) => photo.run(id, i, p, incomingPhotosBytes([p])));
    })();
    recordStoredPhotoBytes(member, bytes, now);
    return mineOf(db.prepare('SELECT * FROM knowledge_drafts WHERE id = ?').get(id) as DraftRow & { state: 'waiting' });
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
                                        sources = NULL, note = NULL, about = NULL
                                    WHERE id = ? AND member_pubkey = ? AND via = 'app' AND state = 'waiting'`).run(iso(now), id, member).changes;
        if (changed === 1) deletePlainRows('knowledge_draft_photos', 'draft_id = ?', id);
        return changed === 1;
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
    return { drafts: rows.map(toCheckOf), total: knowledgeDraftCountAll() };
}

const knowledgeDraftCountAll = () => (db.prepare(`SELECT COUNT(*) AS n FROM knowledge_drafts WHERE state = 'waiting'`).get() as { n: number }).n;

/** One waiting suggestion whole, as the checking screen shows it (§5.3), its photos included; null when none waits. */
export function knowledgeDraftWhole(id: unknown): KnowledgeDraftWhole | null {
    if (typeof id !== 'string' || id.length > 64) return null;
    const r = db.prepare(`SELECT * FROM knowledge_drafts WHERE id = ? AND state = 'waiting'`).get(id) as DraftRow | undefined;
    if (!r) return null;
    return {
        ...toCheckOf(r),
        body: r.body,
        place: r.place,
        sources: sourcesOf(r.sources),
        lang: r.lang,
        about: r.about,
        note: r.note,
        photos: draftPhotoData(r.id),
        needsSourcesTicked: assistantGrantOf(r.via) !== null,
    };
}

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
    };
}

/**
 * The member's kept copy of an answer, in English (core knowledgeAnswerNotice), and the words the route's push carries; null
 * for an assistant's draft, whose owner or admin reads how it ended through their assistant (K6), not the bell.
 */
function keepAnswer(r: DraftRow, answer: Parameters<typeof knowledgeAnswerNotice>[0], data: Record<string, unknown>, now: number): KnowledgeAnswer['notice'] {
    if (assistantGrantOf(r.via) !== null) return null;
    const words = knowledgeAnswerNotice(answer, EN);
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
 * own photos if they add some. Checked is stamped. A fix (slice K5) is never approved here as a new page. In one transaction with
 * the suggestion's answer and its photos' delete, so two owners at once make one page: the second reads "This one was
 * already answered." A member whose account is paused or gone: "This member's account is paused, so it can't be added now."
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
        // A fix changes the page it names, and K5 brings that path: until then none is made, and none is answered as new.
        if (r.kind !== 'new') throw new KnowledgeRefusal(409, 'not_yet', 'A fix to a page is answered by a later version of this server.');
        const grant = assistantGrantOf(r.via);
        if (grant !== null && raw.checkedSources !== true) throw new KnowledgeRefusal(400, 'sources_not_checked', DRAFT_WORDS.tickSources);
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
        if (r.kind !== 'new') throw new KnowledgeRefusal(409, 'not_yet', 'A fix to a page is answered by a later version of this server.');
        db.prepare(`UPDATE knowledge_drafts SET state = 'declined', answered_at = ?, answered_by = ?, reason = ?, reason_words = ?
                    WHERE id = ? AND state = 'waiting'`).run(iso(now), checker, reason, said || null, r.id);
        deletePlainRows('knowledge_draft_photos', 'draft_id = ?', r.id);
        const notice = keepAnswer(r, { outcome: 'declined', title: r.title, reason, words: said }, { outcome: 'declined', reason }, now);
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

/** A member removed or gone (a prune, a self-deletion): their suggestions, those photos and their "This helped" taps go. */
export function dropKnowledgeOf(pubkey: string): void {
    db.transaction(() => {
        deletePlainRows('knowledge_draft_photos', 'draft_id IN (SELECT id FROM knowledge_drafts WHERE member_pubkey = ?)', pubkey);
        deletePlainRows('knowledge_drafts', 'member_pubkey = ?', pubkey);
        deletePlainRows('knowledge_helped', 'member_pubkey = ?', pubkey);
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
