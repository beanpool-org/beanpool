/**
 * Local knowledge on the node (slice K1; scratch/fable-design/DESIGN-local-knowledge-fable.md, amended by
 * DESIGN-local-knowledge-amend-fable.md, every pick Marty's, 11 Nov 2026): the only code that makes or changes a knowledge
 * post, and Learn's own read.
 *
 * - **Made only here.** A knowledge post is a `posts` row of type `knowledge` (price 0, reach local, public, no place ever),
 *   and createPost refuses the type from anyone but publishKnowledge (engine/posts.ts KNOWLEDGE_ONLY_BY_PUBLISH). The public
 *   create route takes offer, need, poll and event only. Every later change goes through this file too: the Market's edit,
 *   pause and resume never find one, since no read gives one to a caller that doesn't ask for it (PostFilter.withKnowledge).
 * - **Who.** An owner or an admin publishes at once, edits, says "Still right", clears a mark and takes one down. The writer,
 *   an owner or an admin may mark one "may be out of date". A member's suggestion and an assistant's draft wait in their own
 *   table and become a post only through an owner's or admin's approval (slice K3, which calls publishKnowledge with the
 *   member as the writer).
 * - **"Checked {date}"** has one meaning: when an owner or admin last confirmed it (publishing, their own edit, "Still
 *   right"). Each of those clears a "may be out of date" mark.
 * - **Learn's read** (knowledgeFront) is grouped by topic, never by date, in @beanpool/core's order rule, and sends rows,
 *   never a body: what the row card draws.
 *
 * Every write here answers 503 on a standby at the route (routes/knowledge.ts); none is a ledger write.
 */
import {
    KNOWLEDGE_FRONT_ROWS, KNOWLEDGE_LIMITS, KNOWLEDGE_SEARCH_MAX, KNOWLEDGE_TOPIC_PAGE, KNOWLEDGE_TOPICS, LANGS,
    compareKnowledge, isKnowledgeTopic, knowledgeFirstLine, knowledgeTopic, pinLive, word, wordsFor,
    type KnowledgeFront, type KnowledgeRow, type KnowledgeSearch, type KnowledgeSource, type KnowledgeTopicPage,
} from '@beanpool/core';
import { getPosts, type MarketplacePost } from '@beanpool/engine';
import { db } from '../db/db.js';
import { cleanMemberText } from '../agent/fence.js';
import { createPost, knowledgeDoorbell } from './posts.js';
import { nodeRoleOf } from './node-roles.js';
import { bumpPostsVersion } from './versions.js';
import { assertNotMuted } from './auto-moderation.js';
import { assertMayPostToday } from './writer-bounds.js';

// A refusal with a value in it, in English as a template wrote it, its sentence marked for the way out to find again in the
// member's language (member-words.ts).
const { t: tr } = wordsFor('en');

type BroadcastFn = (event: any, recipients?: string[], opts?: { listingParties?: string[] }) => void;

/** A refusal with its HTTP status and code, in words a member reads (routes/knowledge.ts answers it as it is). */
export class KnowledgeRefusal extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message);
        this.name = 'KnowledgeRefusal';
    }
}

export const KNOWLEDGE_WORDS = {
    adminsOnly: word('Only this community’s owners and admins can do this to Local knowledge.'),
    notFound: word('This page of Local knowledge isn’t showing any more.'),
    writerOrAdmins: word('Only its writer, or this community’s owners and admins, can mark it out of date.'),
    noTitle: word('Give it a title.'),
    noBody: word('Write what people should know.'),
    noTopic: word('Pick a topic.'),
    badLink: word('A link must start with https:// or http://'),
    linkWithLogin: word('A link must not hold a user name or password.'),
    photos: word('A photo must be one you took, as an image.'),
} as const;

/** What a form sends: the page's words, its topic, and what is optional. */
export interface KnowledgeInput {
    title?: unknown;
    body?: unknown;
    topic?: unknown;
    place?: unknown;
    sources?: unknown;
    lang?: unknown;
}

/** The page's words, cleaned and held to the limits (KNOWLEDGE_LIMITS). */
export interface CleanKnowledge {
    title: string;
    body: string;
    topic: string;
    place: string | null;
    sources: KnowledgeSource[];
    lang: string | null;
}

const charCount = (s: string): number => Array.from(s).length;

/** One line a member typed: hidden characters out (agent/fence.ts), spaces closed up. */
function oneLine(raw: unknown, max: number): string {
    return cleanMemberText(typeof raw === 'string' ? raw : '', max * 4).replace(/\s+/g, ' ').trim();
}

/** Plain text with paragraphs: hidden characters out, at most one empty line between paragraphs, no markup made of it. */
function paragraphs(raw: unknown, max: number): string {
    return cleanMemberText(typeof raw === 'string' ? raw : '', max * 4)
        .split('\n').map((line) => line.replace(/[^\S\n]+/g, ' ').trim()).join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Over its limit: the field's own sentence (whole sentences only, so each is translated as one). */
function tooLong(message: string): KnowledgeRefusal {
    return new KnowledgeRefusal(400, 'too_long', message);
}

/**
 * A source's address by a join link's rule (engine/posts.ts cleanEventLink): http or https, at most 500 characters, no user
 * name or password (`https://bank.example@evil.example` goes to evil.example), stored as the URL parser writes it.
 */
function cleanSourceUrl(raw: unknown): string {
    const v = typeof raw === 'string' ? raw.trim() : '';
    let url: URL | null = null;
    try { url = new URL(v); } catch { url = null; }
    if (!url || !/^https?:$/.test(url.protocol) || !/^https?:\/\//i.test(v)) throw new KnowledgeRefusal(400, 'bad_link', KNOWLEDGE_WORDS.badLink);
    if (url.username || url.password) throw new KnowledgeRefusal(400, 'bad_link', KNOWLEDGE_WORDS.linkWithLogin);
    if (v.length > KNOWLEDGE_LIMITS.sourceUrl || url.href.length > KNOWLEDGE_LIMITS.sourceUrl) throw tooLong(tr('Keep a link to {n} characters.', { n: KNOWLEDGE_LIMITS.sourceUrl }));
    return url.href;
}

/** The form's fields, cleaned, or a refusal in the words the form shows (§3.3). */
export function cleanKnowledgeInput(raw: KnowledgeInput): CleanKnowledge {
    const title = oneLine(raw.title, KNOWLEDGE_LIMITS.title);
    if (!title) throw new KnowledgeRefusal(400, 'no_title', KNOWLEDGE_WORDS.noTitle);
    if (charCount(title) > KNOWLEDGE_LIMITS.title) throw tooLong(tr('Keep the title to {n} characters.', { n: KNOWLEDGE_LIMITS.title }));
    const body = paragraphs(raw.body, KNOWLEDGE_LIMITS.body);
    if (!body) throw new KnowledgeRefusal(400, 'no_body', KNOWLEDGE_WORDS.noBody);
    if (charCount(body) > KNOWLEDGE_LIMITS.body) throw tooLong(tr('Keep what to know to {n} characters.', { n: KNOWLEDGE_LIMITS.body }));
    if (!isKnowledgeTopic(raw.topic)) throw new KnowledgeRefusal(400, 'no_topic', KNOWLEDGE_WORDS.noTopic);
    const place = oneLine(raw.place, KNOWLEDGE_LIMITS.place);
    if (charCount(place) > KNOWLEDGE_LIMITS.place) throw tooLong(tr('Keep the place to {n} characters.', { n: KNOWLEDGE_LIMITS.place }));
    if (raw.sources !== undefined && raw.sources !== null && !Array.isArray(raw.sources)) {
        throw new KnowledgeRefusal(400, 'bad_request', 'sources is a list of { url, label }');
    }
    const list = (raw.sources as unknown[] | undefined) ?? [];
    if (list.length > KNOWLEDGE_LIMITS.sources) throw new KnowledgeRefusal(400, 'too_many_sources', tr('At most {n} links.', { n: KNOWLEDGE_LIMITS.sources }));
    const sources = list.map((s): KnowledgeSource => {
        const item = (s && typeof s === 'object' ? s : {}) as { url?: unknown; label?: unknown };
        const label = oneLine(item.label, KNOWLEDGE_LIMITS.sourceLabel);
        if (charCount(label) > KNOWLEDGE_LIMITS.sourceLabel) throw tooLong(tr('Keep what the page is to {n} characters.', { n: KNOWLEDGE_LIMITS.sourceLabel }));
        return { url: cleanSourceUrl(item.url), label };
    });
    const lang = typeof raw.lang === 'string' && (LANGS as readonly string[]).includes(raw.lang) ? raw.lang : null;
    return { title, body, topic: raw.topic, place: place || null, sources, lang };
}

/**
 * The words a page is also found by, beside its title and body (§2.7): its place, and its topic's name and words in English,
 * as a tag's words are. The node's createPost puts its title, body and the topic id in front.
 */
export function knowledgeKeywords(k: Pick<CleanKnowledge, 'topic' | 'place'>): string {
    const topic = knowledgeTopic(k.topic);
    return [topic ? `${topic.label} ${topic.keywords}` : '', k.place ?? ''].join(' ').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Whether this key may publish, edit, confirm, clear a mark on and take down Local knowledge: an owner or an admin. */
export function checksKnowledge(key: string): boolean {
    const role = nodeRoleOf(key);
    return role === 'owner' || role === 'admin';
}

function assertChecker(key: string): void {
    if (!checksKnowledge(key)) throw new KnowledgeRefusal(403, 'admins_only', KNOWLEDGE_WORDS.adminsOnly);
}

/** A showing knowledge post's row, or a 404 refusal. */
function showingRow(postId: unknown): { id: string; author_pubkey: string; knowledge_place: string | null } {
    const row = typeof postId === 'string' && postId.length <= 200
        ? db.prepare(`SELECT id, author_pubkey, knowledge_place FROM posts
                       WHERE id = ? AND type = 'knowledge' AND active = 1 AND status = 'active' AND removed_by_moderator_at IS NULL`)
            .get(postId) as { id: string; author_pubkey: string; knowledge_place: string | null } | undefined
        : undefined;
    if (!row) throw new KnowledgeRefusal(404, 'not_found', KNOWLEDGE_WORDS.notFound);
    return row;
}

/** The post as its reader reads it now, knowledge fields and all. */
export function readKnowledgePost(postId: string, reader: string): MarketplacePost | null {
    return getPosts(db, { id: postId, type: 'knowledge', withKnowledge: true, viewerPubkey: reader, includeHidden: !!nodeRoleOf(reader) })[0] ?? null;
}

/** Tells every socket a knowledge post changed: a doorbell, no words (engine/posts.ts knowledgeDoorbell). */
function ring(broadcast: BroadcastFn, postId: string, at: string): void {
    broadcast({ type: 'post_updated', post: knowledgeDoorbell({ id: postId, updatedAt: at, createdAt: at }) });
}

/**
 * Makes a knowledge post. Slice K1: an owner's or admin's own, which publishes at once (§2.4); K3's approval calls it with
 * the member as `writer` and the approving owner or admin as `checker`. `photos`: the writer's own, optional, at most 3,
 * as a listing's are sent (data URLs), through createPost's photo rules. Counts against the writer's posts a day
 * (engine/writer-bounds.ts), as every post does.
 */
export function publishKnowledge(
    broadcast: BroadcastFn,
    checker: string,
    raw: KnowledgeInput & { photos?: unknown },
    opts: { writer?: string; createdVia?: string; now?: number } = {},
): MarketplacePost {
    assertChecker(checker);
    assertNotMuted(checker);
    const k = cleanKnowledgeInput(raw);
    if (raw.photos !== undefined && raw.photos !== null && (!Array.isArray(raw.photos) || raw.photos.some((p) => typeof p !== 'string'))) {
        throw new KnowledgeRefusal(400, 'bad_photos', KNOWLEDGE_WORDS.photos);
    }
    const photos = (raw.photos as string[] | undefined) ?? [];
    if (photos.length > KNOWLEDGE_LIMITS.photos) throw new KnowledgeRefusal(400, 'too_many_photos', tr('At most {n} photos.', { n: KNOWLEDGE_LIMITS.photos }));
    const writer = opts.writer ?? checker;
    const at = new Date(opts.now ?? Date.now()).toISOString();
    const post = createPost(broadcast, 'knowledge', k.topic, k.title, k.body, 0, 'fixed', writer, undefined, undefined, photos, false, undefined, false, {
        knowledge: { sources: k.sources.length > 0 ? JSON.stringify(k.sources) : null, place: k.place, lang: k.lang, checkedAt: at, keywords: knowledgeKeywords(k) },
        beforeWrite: () => assertMayPostToday(writer),
        ...(opts.createdVia ? { createdVia: opts.createdVia } : {}),
    });
    if (!post) throw new KnowledgeRefusal(400, 'not_member', word('Failed — author must be a registered member'));
    return post;
}

/**
 * An owner's or admin's own edit of a page showing (§2.4: "at once"): the whole page as the form sends it, words, topic,
 * place, sources and language; its photos stay. Stamps Checked and clears a "may be out of date" mark, as approving does.
 */
export function editKnowledge(broadcast: BroadcastFn, checker: string, postId: unknown, raw: KnowledgeInput, now = Date.now()): MarketplacePost {
    assertChecker(checker);
    assertNotMuted(checker);
    const row = showingRow(postId);
    const k = cleanKnowledgeInput(raw);
    const at = new Date(now).toISOString();
    const keywords = `${k.topic} ${knowledgeKeywords(k)}`;
    db.prepare(`UPDATE posts SET title = ?, description = ?, category = ?, search_keywords = ?,
                    knowledge_sources = ?, knowledge_place = ?, knowledge_lang = ?, knowledge_checked_at = ?,
                    knowledge_outdated_at = NULL, knowledge_outdated_note = NULL, updated_at = ?
                 WHERE id = ?`)
        .run(k.title, k.body, k.topic, keywords, k.sources.length > 0 ? JSON.stringify(k.sources) : null, k.place, k.lang, at, at, row.id);
    bumpPostsVersion();
    ring(broadcast, row.id, at);
    return readKnowledgePost(row.id, checker)!;
}

/** "Still right" (§2.4): an owner or admin confirms a page as it shows. Re-stamps Checked and clears a mark. */
export function confirmKnowledge(broadcast: BroadcastFn, checker: string, postId: unknown, now = Date.now()): MarketplacePost {
    assertChecker(checker);
    const row = showingRow(postId);
    const at = new Date(now).toISOString();
    db.prepare(`UPDATE posts SET knowledge_checked_at = ?, knowledge_outdated_at = NULL, knowledge_outdated_note = NULL, updated_at = ? WHERE id = ?`)
        .run(at, at, row.id);
    bumpPostsVersion();
    ring(broadcast, row.id, at);
    return readKnowledgePost(row.id, checker)!;
}

/**
 * Marks a page "may be out of date" (§2.4): its writer, an owner or an admin, with why (at most 140 characters, may be
 * empty). Marked again, the note and the time are the new ones. A member who is neither says what changed instead (K5).
 */
export function markKnowledgeOutdated(broadcast: BroadcastFn, actor: string, postId: unknown, note: unknown, now = Date.now()): MarketplacePost {
    const row = showingRow(postId);
    if (row.author_pubkey !== actor && !checksKnowledge(actor)) throw new KnowledgeRefusal(403, 'writer_or_admins', KNOWLEDGE_WORDS.writerOrAdmins);
    const clean = oneLine(note, KNOWLEDGE_LIMITS.outdatedNote);
    if (charCount(clean) > KNOWLEDGE_LIMITS.outdatedNote) throw tooLong(tr('Keep the note to {n} characters.', { n: KNOWLEDGE_LIMITS.outdatedNote }));
    const at = new Date(now).toISOString();
    db.prepare(`UPDATE posts SET knowledge_outdated_at = ?, knowledge_outdated_note = ?, updated_at = ? WHERE id = ?`).run(at, clean || null, at, row.id);
    bumpPostsVersion();
    ring(broadcast, row.id, at);
    return readKnowledgePost(row.id, actor)!;
}

/** Clears a "may be out of date" mark (§2.4): an owner or an admin. Checked stays as it was: "Still right" re-stamps it. */
export function clearKnowledgeOutdated(broadcast: BroadcastFn, checker: string, postId: unknown, now = Date.now()): MarketplacePost {
    assertChecker(checker);
    const row = showingRow(postId);
    const at = new Date(now).toISOString();
    db.prepare(`UPDATE posts SET knowledge_outdated_at = NULL, knowledge_outdated_note = NULL, updated_at = ? WHERE id = ?`).run(at, row.id);
    bumpPostsVersion();
    ring(broadcast, row.id, at);
    return readKnowledgePost(row.id, checker)!;
}

/** An owner's or admin's take-down: checks the page is one, then the route runs Settings' own removal (adminDeletePost). */
export function assertMayTakeDownKnowledge(checker: string, postId: unknown): string {
    assertChecker(checker);
    return showingRow(postId).id;
}

// ── Learn's read ─────────────────────────────────────────────────────────────────────────

/** The most pages one read of Learn weighs: far more than any community writes, and bounded all the same. */
export const KNOWLEDGE_READ_MAX = 2_000;

/** The row card's fields of a post read as a member reads it: never the body, only its first line. */
export function knowledgeRowOf(p: MarketplacePost, now = Date.now()): KnowledgeRow {
    return {
        id: p.id,
        title: p.title,
        line: knowledgeFirstLine(p.description),
        topic: p.category,
        photo: p.photos?.[0] ?? null,
        checkedAt: p.knowledge?.checkedAt ?? p.createdAt,
        helped: p.knowledge?.helped ?? 0,
        pinned: pinLive(p, now),
        outdated: !!p.knowledge?.outdatedAt,
    };
}

/**
 * The pages showing to this reader, as the Market's own read shows a post (getPosts): active, its author on the board, in
 * the reader's audience, and not one hidden by reports (a moderator meets those in the queue, not in Learn).
 */
function showingTo(reader: string, query?: string): MarketplacePost[] {
    return getPosts(db, { type: 'knowledge', withKnowledge: true, viewerPubkey: reader, query, limit: KNOWLEDGE_READ_MAX })
        .filter((p) => !p.hiddenByReportsAt);
}

const byLearnOrder = (a: KnowledgeRow, b: KnowledgeRow) => compareKnowledge(a, b);

/** Learn's front (amended §4.2): the pinned pages, then each topic that holds something, its count and its first rows. */
export function knowledgeFront(reader: string, now = Date.now()): KnowledgeFront {
    const rows = showingTo(reader).map((p) => knowledgeRowOf(p, now)).sort(byLearnOrder);
    const topics = KNOWLEDGE_TOPICS.map((t) => {
        const of = rows.filter((r) => r.topic === t.id);
        return { id: t.id as string, count: of.length, rows: of.slice(0, KNOWLEDGE_FRONT_ROWS) };
    }).filter((t) => t.count > 0);
    return { total: rows.length, pinned: rows.filter((r) => r.pinned), topics };
}

/** One topic, every row in Learn's order, a page at a time (`offset`). */
export function knowledgeTopicPage(reader: string, topic: string, offset = 0, now = Date.now()): KnowledgeTopicPage {
    const rows = showingTo(reader).map((p) => knowledgeRowOf(p, now)).filter((r) => r.topic === topic).sort(byLearnOrder);
    const page = rows.slice(offset, offset + KNOWLEDGE_TOPIC_PAGE);
    return { topic, count: rows.length, rows: page, next: offset + KNOWLEDGE_TOPIC_PAGE < rows.length ? offset + KNOWLEDGE_TOPIC_PAGE : null };
}

/**
 * A search of Learn (amended §2.7): the node's search over title, body, place and topic words (the Market's own, FTS with
 * its fallback for unspaced scripts), best match first: a word in the title counts most, then in the place, then in the
 * body; ties in Learn's order. At most KNOWLEDGE_SEARCH_MAX rows.
 */
export function knowledgeSearch(reader: string, q: string, now = Date.now()): KnowledgeSearch {
    const found = showingTo(reader, q);
    const terms = q.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
    const score = (p: MarketplacePost): number => {
        const title = p.title.toLowerCase();
        const place = (p.knowledge?.place ?? '').toLowerCase();
        const body = p.description.toLowerCase();
        return terms.reduce((n, w) => n + (title.includes(w) ? 3 : 0) + (place.includes(w) ? 2 : 0) + (body.includes(w) ? 1 : 0), 0);
    };
    const scored = found.map((p) => ({ score: score(p), row: knowledgeRowOf(p, now) }));
    scored.sort((a, b) => b.score - a.score || byLearnOrder(a.row, b.row));
    return { total: scored.length, rows: scored.slice(0, KNOWLEDGE_SEARCH_MAX).map((s) => s.row) };
}
