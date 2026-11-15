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
    KNOWLEDGE_FRONT_ROWS, KNOWLEDGE_LIMITS, KNOWLEDGE_SEARCH_MAX, KNOWLEDGE_TOPIC_PAGE, KNOWLEDGE_TOPICS, KNOWLEDGE_UNCHECKED_ROWS, LANGS, LEARN_HOME_NEW_DAYS,
    LEARN_HOME_ROWS, PULSE_KNOWLEDGE_DAYS, PULSE_KNOWLEDGE_ID_PREFIX, PULSE_KNOWLEDGE_MAX_PAGES, PULSE_KNOWLEDGE_ROWS, PULSE_KNOWLEDGE_SOURCE,
    compareKnowledge, isKnowledgeTopic, knowledgeFirstLine, knowledgeTopic, knowledgeUncheckedForAYear, pinLive, word, wordsFor,
    type HomeLearnRow, type KnowledgeFront, type KnowledgeHelped, type KnowledgeRow, type KnowledgeSearch, type KnowledgeSource, type KnowledgeTopicPage,
    type PulseKnowledgeCard, type PulseKnowledgePost,
} from '@beanpool/core';
import { getPosts, type MarketplacePost } from '@beanpool/engine';
import { db, deletePlainRows } from '../db/db.js';
import { cleanMemberText } from '../agent/fence.js';
import { createPost, knowledgeDoorbell } from './posts.js';
import { nodeRoleOf } from './node-roles.js';
import { bumpPostsVersion } from './versions.js';
import { assertNotMuted } from './auto-moderation.js';
import { assertMayPostToday } from './writer-bounds.js';
import { probationState } from './probation.js';

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
    ownPage: word('This is your own page: “This helped” is for other members.'),
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

/** A showing knowledge post's row, as an owner or admin acts on it (one hidden by reports included). */
export interface ShowingKnowledgeRow {
    id: string;
    author_pubkey: string;
    title: string;
    description: string;
    category: string;
    knowledge_place: string | null;
    knowledge_sources: string | null;
    knowledge_lang: string | null;
}

/** A showing knowledge post's row, or null. */
export function showingKnowledgeRow(postId: unknown): ShowingKnowledgeRow | null {
    return typeof postId === 'string' && postId.length <= 200
        ? (db.prepare(`SELECT id, author_pubkey, title, description, category, knowledge_place, knowledge_sources, knowledge_lang FROM posts
                        WHERE id = ? AND type = 'knowledge' AND active = 1 AND status = 'active' AND removed_by_moderator_at IS NULL`)
            .get(postId) as ShowingKnowledgeRow | undefined) ?? null
        : null;
}

/** A showing knowledge post's row, or a 404 refusal. */
function showingRow(postId: unknown): ShowingKnowledgeRow {
    const row = showingKnowledgeRow(postId);
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
 * (engine/writer-bounds.ts), as every post does. `photosPaidFor`: the photos were charged to their sender's photo budget
 * when the suggestion was sent (engine/knowledge-drafts.ts), so storing them as the page's charges nobody again.
 */
export function publishKnowledge(
    broadcast: BroadcastFn,
    checker: string,
    raw: KnowledgeInput & { photos?: unknown },
    opts: { writer?: string; createdVia?: string; now?: number; photosPaidFor?: boolean } = {},
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
        ...(opts.photosPaidFor ? { photosPaidFor: true } : {}),
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
    return rewriteKnowledge(broadcast, checker, row.id, cleanKnowledgeInput(raw), now);
}

/**
 * Writes a page's words as an owner or admin confirmed them: their own edit, or a fix they approved (engine/knowledge-drafts.ts,
 * slice K5). Its writer and photos stay; Checked is stamped and a "may be out of date" mark cleared. `postId` is showing.
 */
export function rewriteKnowledge(broadcast: BroadcastFn, checker: string, postId: string, k: CleanKnowledge, now = Date.now()): MarketplacePost {
    const at = new Date(now).toISOString();
    const keywords = `${k.topic} ${knowledgeKeywords(k)}`;
    db.prepare(`UPDATE posts SET title = ?, description = ?, category = ?, search_keywords = ?,
                    knowledge_sources = ?, knowledge_place = ?, knowledge_lang = ?, knowledge_checked_at = ?,
                    knowledge_outdated_at = NULL, knowledge_outdated_note = NULL, updated_at = ?
                 WHERE id = ?`)
        .run(k.title, k.body, k.topic, keywords, k.sources.length > 0 ? JSON.stringify(k.sources) : null, k.place, k.lang, at, at, postId);
    bumpPostsVersion();
    ring(broadcast, postId, at);
    return readKnowledgePost(postId, checker)!;
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

// ── "This helped" (slice K5) ─────────────────────────────────────────────────────────────

/**
 * "This helped" (§2.10): one tap per member per page, taken back by a second (`on` false). Only a page the member can read
 * now (pageShowingTo), never their own (403 `own_page`). Whether the tap counts is stamped at the tap and never worked out
 * again (the anonymous-counts rule): it counts unless the member is on probation where the node has probation (an owner
 * or admin never is). The page's count (`posts.knowledge_helped`) is the counted taps, written with the tap, so a sync and a
 * standby carry it; the row of who tapped (`knowledge_helped`) goes to nobody. Tapping on again, or taking back a tap
 * that isn't there, changes nothing. Pays nothing (no Beans for steps). The route has checked an active member on the
 * main server.
 */
export function markKnowledgeHelped(reader: string, postId: unknown, on: unknown, now = Date.now()): KnowledgeHelped {
    if (typeof on !== 'boolean') throw new KnowledgeRefusal(400, 'bad_request', 'on is true or false.');
    const page = pageShowingTo(reader, postId);
    if (!page) throw new KnowledgeRefusal(404, 'not_found', KNOWLEDGE_WORDS.notFound);
    if (page.authorPublicKey === reader) throw new KnowledgeRefusal(403, 'own_page', KNOWLEDGE_WORDS.ownPage);
    return db.transaction((): KnowledgeHelped => {
        const had = !!db.prepare('SELECT 1 FROM knowledge_helped WHERE post_id = ? AND member_pubkey = ?').get(page.id, reader);
        if (on && !had) {
            const counted = probationState(reader, now).onProbation ? 0 : 1;
            db.prepare('INSERT INTO knowledge_helped (post_id, member_pubkey, counted, at) VALUES (?, ?, ?, ?)').run(page.id, reader, counted, new Date(now).toISOString());
        } else if (!on && had) {
            deletePlainRows('knowledge_helped', 'post_id = ? AND member_pubkey = ?', page.id, reader);
        }
        return { helped: recountKnowledgeHelped([page.id], now).get(page.id) ?? 0, helpedByMe: on };
    })();
}

/**
 * Sets each page's count of "This helped" (`posts.knowledge_helped`) to its counted taps, moving its watermark only where the
 * count changed, so a sync and a standby carry it. After a tap, and after a member's taps go with their account
 * (engine/knowledge-drafts.ts dropKnowledgeOf). Answers each page's count.
 */
export function recountKnowledgeHelped(postIds: readonly string[], now = Date.now()): Map<string, number> {
    const counts = new Map<string, number>();
    const count = db.prepare('SELECT COUNT(*) AS n FROM knowledge_helped WHERE post_id = ? AND counted = 1');
    const stored = db.prepare('SELECT knowledge_helped AS n FROM posts WHERE id = ?');
    const write = db.prepare('UPDATE posts SET knowledge_helped = ?, updated_at = ? WHERE id = ?');
    let changed = false;
    for (const id of new Set(postIds)) {
        const n = (count.get(id) as { n: number }).n;
        const was = stored.get(id) as { n: number } | undefined;
        if (was && was.n !== n) {
            write.run(n, new Date(now).toISOString(), id);
            changed = true;
        }
        counts.set(id, n);
    }
    if (changed) bumpPostsVersion();
    return counts;
}

/**
 * A member's signed read of pages by id, with `helpedByMe` on each knowledge post: whether this reader tapped "This helped".
 * routes/marketplace.ts adds it to an `id=` or `ids=` read only (never a list, a sync or a copy).
 */
export function withHelpedByMe(posts: MarketplacePost[], reader: string): MarketplacePost[] {
    const ids = posts.filter((p) => p.knowledge).map((p) => p.id);
    if (ids.length === 0) return posts;
    const mine = new Set((db.prepare(`SELECT post_id FROM knowledge_helped WHERE member_pubkey = ? AND post_id IN (${ids.map(() => '?').join(',')})`)
        .all(reader, ...ids) as { post_id: string }[]).map((r) => r.post_id));
    return posts.map((p) => (p.knowledge ? { ...p, knowledge: { ...p.knowledge, helpedByMe: mine.has(p.id) } } : p));
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
 * The pages showing to this reader, as the Market's own read shows a post (getPosts): active, its writer's account not
 * paused, in the reader's audience, and not one hidden by reports (a moderator meets those in the queue, not in Learn).
 * Its writer's holiday never takes a page out: holiday is a pause of trade, and a page is none (@beanpool/engine posts.ts
 * NOT_ON_HOLIDAY_SQL, the review of #3063), so Emergencies keeps its pages while their writer is away.
 */
export function showingTo(reader: string, query?: string): MarketplacePost[] {
    return getPosts(db, { type: 'knowledge', withKnowledge: true, viewerPubkey: reader, query, limit: KNOWLEDGE_READ_MAX })
        .filter((p) => !p.hiddenByReportsAt);
}

/** One page showing to this reader, by the same rules as showingTo (an assistant's knowledge_get, agent/knowledge.ts); else null. */
export function pageShowingTo(reader: string, postId: unknown): MarketplacePost | null {
    if (typeof postId !== 'string' || !postId || postId.length > 200) return null;
    const p = getPosts(db, { id: postId, type: 'knowledge', withKnowledge: true, viewerPubkey: reader })[0];
    return p && p.type === 'knowledge' && !p.hiddenByReportsAt && p.status === 'active' ? p : null;
}

const byLearnOrder = (a: KnowledgeRow, b: KnowledgeRow) => compareKnowledge(a, b);

/**
 * "Not checked for a year" (§5.2), for To check: the pages showing to this owner or admin that nobody confirmed for more than
 * KNOWLEDGE_UNCHECKED_DAYS, the oldest checked first, at most KNOWLEDGE_UNCHECKED_ROWS. Information, never a count in the bell.
 */
export function knowledgeUnchecked(reader: string, now = Date.now()): { total: number; rows: KnowledgeRow[] } {
    const rows = showingTo(reader).map((p) => knowledgeRowOf(p, now)).filter((r) => knowledgeUncheckedForAYear(r.checkedAt, now))
        .sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { total: rows.length, rows: rows.slice(0, KNOWLEDGE_UNCHECKED_ROWS) };
}

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

// ── Home's card (slice K7) ───────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/**
 * The node's own day, YYYY-MM-DD in its local time: the day the Home card's pick and a Pulse knowledge card belong to.
 */
export function nodeLocalDay(now: number): string {
    return new Date(now - new Date(now).getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/** A page's place in one day's pick: FNV-1a over the day and the page's id, so every member draws the same order that day. */
function dayRank(day: string, id: string): number {
    let h = 0x811c9dc5;
    const text = `${day}\n${id}`;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
}

/**
 * The Home card's rows (amended §3.6) from the pages showing: first the newest page, marked new, if it first showed (was
 * published) in the last LEARN_HOME_NEW_DAYS days; then pages picked by the node's day, the same for every member that day,
 * so the card doesn't reshuffle at each open and changes the next day. A page marked "may be out of date" comes after every
 * page that isn't, as Learn lists it. A new page joins the day's order where its rank falls and moves no other page.
 */
export function learnHomeRows(pages: readonly MarketplacePost[], now = Date.now()): HomeLearnRow[] {
    const day = nodeLocalDay(now);
    const at = (p: MarketplacePost) => { const ms = Date.parse(p.createdAt); return Number.isFinite(ms) ? ms : -Infinity; };
    const newest = pages.reduce<MarketplacePost | null>((best, p) => (!best || at(p) > at(best) || (at(p) === at(best) && p.id > best.id) ? p : best), null);
    const out: HomeLearnRow[] = [];
    const fresh = newest && now - at(newest) < LEARN_HOME_NEW_DAYS * DAY_MS ? newest : null;
    if (fresh) out.push({ ...knowledgeRowOf(fresh, now), isNew: true });
    const rest = pages.filter((p) => p !== fresh).map((p) => ({ row: knowledgeRowOf(p, now), rank: dayRank(day, p.id) }));
    rest.sort((a, b) => Number(a.row.outdated) - Number(b.row.outdated) || a.rank - b.rank || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0));
    for (const { row } of rest.slice(0, LEARN_HOME_ROWS - out.length)) out.push(row);
    return out;
}

// ── The Pulse's card (slice KP) ──────────────────────────────────────────────────────────

/** Characters of a row's first line on the Pulse's card, as on Home's Learn card: a line, not the page. */
export const PULSE_KNOWLEDGE_LINE_CHARS = 140;

function clipLine(s: string, max: number): string {
    const chars = Array.from(s);
    return chars.length <= max ? s : `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * The Pulse's knowledge cards (amended §2.12, §3.8), worked out from `pages`, the pages showing to the reader (showingTo,
 * Learn's own rule: a page that leaves Learn, taken down, hidden by reports, its writer removed or paused, leaves the Pulse
 * at the same read, with no write of its own). Those first shown in the last PULSE_KNOWLEDGE_DAYS days, the newest
 * PULSE_KNOWLEDGE_MAX_PAGES of them, make one card per node local day (nodeLocalDay), newest first:
 * id `know_<day>`, placed at the day's newest page's time, titled with its title, its rows the newest
 * PULSE_KNOWLEDGE_ROWS of the day. "First shown" is when the post was made: an owner's or admin's own page at Publish, a
 * member's suggestion and an assistant's draft at approval (publishKnowledge makes the post then). A fix, "Still right", a
 * mark and a pin never move it, so they announce nothing. "by {name}" only on a single page a member wrote; none when
 * grouped or gathered with the assistant. Nothing is stored: a standby works out the same from the posts it holds.
 */
export function knowledgePulseCards(pages: readonly MarketplacePost[], now = Date.now()): PulseKnowledgeCard[] {
    const since = now - PULSE_KNOWLEDGE_DAYS * DAY_MS;
    const shown = pages
        .map((p) => ({ p, at: Date.parse(p.createdAt) }))
        .filter(({ at }) => Number.isFinite(at) && at > since)
        .sort((a, b) => b.at - a.at || (a.p.id < b.p.id ? 1 : a.p.id > b.p.id ? -1 : 0))
        .slice(0, PULSE_KNOWLEDGE_MAX_PAGES);
    const byDay = new Map<string, typeof shown>();
    for (const s of shown) {
        const day = nodeLocalDay(s.at);
        const list = byDay.get(day);
        if (list) list.push(s); else byDay.set(day, [s]);
    }
    return [...byDay.entries()].map(([day, list]): PulseKnowledgeCard => {
        const single = list.length === 1;
        const posts = list.slice(0, PULSE_KNOWLEDGE_ROWS).map(({ p }): PulseKnowledgePost => {
            const gathered = p.knowledge?.gathered === true;
            return {
                id: p.id,
                title: p.title,
                topic: p.category,
                line: clipLine(knowledgeFirstLine(p.description), PULSE_KNOWLEDGE_LINE_CHARS),
                photo: p.photos?.[0] ?? null,
                by: single && !gathered && p.authorCallsign ? p.authorCallsign : null,
                gathered,
            };
        });
        return {
            id: `${PULSE_KNOWLEDGE_ID_PREFIX}${day}`,
            source: PULSE_KNOWLEDGE_SOURCE,
            platform: 'beanpool',
            category: 'knowledge',
            url: null,
            thumbnailUrl: null,
            ownerPubkey: '',
            callsign: '',
            avatarUrl: null,
            isVerified: false,
            title: list[0].p.title,
            publishedAt: new Date(list[0].at).toISOString(),
            knowledge: { count: list.length, posts },
        };
    });
}
