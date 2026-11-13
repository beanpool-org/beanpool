/**
 * The forum (scratch/fable-design/DESIGN-forums-fable.md §2 to §4, §16, §20; slice F1): sections, topics with a title, and
 * replies under them, readable by this community's members. routes/forum.ts answers it; @beanpool/core forum.ts holds the
 * limits, the starter sections and the order.
 *
 * - **Who reads.** Members of this community, whatever its kind: anyone else nothing (the routes answer 403 `not_member`, as
 *   Learn's do). A topic or post by someone the reader blocked is left out of every answer, as listings are. The public
 *   pages of the global community's forum are slice F7, through `public_from`, which nothing stamps yet.
 * - **Who writes.** An active, unmuted member: a topic in a section open to members, a reply in an open topic, an edit or a
 *   removal of their own post, closing their own topic. Owners and admins also start topics in "News from BeanPool" (a
 *   section for staff), close and move any topic, pin, and make, rename, order and archive sections. Moderators get reports
 *   and first looks with slice F2 (Marty, Q4, 14 Nov 2026): nothing here is theirs.
 * - **Told first.** Where the forum is public (`forumPublic`, the global community), a member's first post is refused until
 *   they were told, once, that anyone on the web can read it with their name (`POST /api/forum/told`).
 * - **Limits.** 10 topics and 100 replies in any 24 hours (owners and admins: the "Owner and admin limit"); a removed topic
 *   or reply still counts, so remove-and-repost resets nothing. A new account's smaller numbers are slice F2's.
 * - **Removing.** A reply or an opening post keeps its row as a marker, its words blanked and its photos deleted. A topic its
 *   writer removes with no one else's reply in it is gone from every list and read (`closed_by` 'removed'); with others'
 *   replies, its title and opening words are blanked, it closes, and the replies stay. Deleting an account does the same to
 *   every post of theirs; the wording before an edit and their photos go with tombstones.
 * - **Starter sections** are made once, by the main server, the first time it finds the forum with none, and a marker in
 *   node_config stops them coming back (design §20). A standby makes nothing: its main server's come in its copy.
 *
 * Every write refuses on a standby (assertPlainTablesWritable, 503 `standby` at the route). No log line holds a post's words.
 */
import crypto from 'node:crypto';
import {
    FORUM_DAY_LIMITS, FORUM_LIMITS, FORUM_STARTER_SECTIONS, forumLinksFit, forumMentionsFit, isLang, word, wordsFor,
    type ForumSectionStarts,
} from '@beanpool/core';
import { getMember, validatePostPhotos } from '@beanpool/engine';
import { db, deletePlainRows } from '../db/db.js';
import { getNodeProfile, getProfileSwitches } from '../config/node-profile.js';
import { assertPlainTablesWritable } from '../config/node-role.js';
import { cleanMemberText } from '../agent/fence.js';
import { stripImageValue } from '../storage/image-metadata.js';
import { getNodeRole } from './sync.js';
import { assertNotMuted } from './auto-moderation.js';
import { nodeRoleOf } from './node-roles.js';
import { ownerAdminLimit } from './owner-admin-limit.js';
import { getMembersVersion } from './versions.js';
import { POST_PHOTO_FORMAT_ERROR } from './posts.js';
import { photoRefusalError, photosRefusal } from './avatar.js';
import { assertMayStorePhotoBytes, incomingPhotosBytes, recordStoredPhotoBytes } from './photo-upload-budget.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
// A refusal with a value in it, in English as a template wrote it, its sentence marked for the way out to find again in the
// member's language (member-words.ts).
const { t: tr } = wordsFor('en');

/** The node_config key that says the starter sections were made, so deleting them all never brings them back. */
export const FORUM_STARTERS_MADE_KEY = 'forum.startersMade';

export class ForumRefusal extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message);
        this.name = 'ForumRefusal';
    }
}

export const FORUM_WORDS = {
    notFound: word('This topic isn’t here any more.'),
    postNotFound: word('This post isn’t here any more.'),
    sectionNotFound: word('This section isn’t here any more.'),
    closed: word('This topic is closed, so it takes no new replies.'),
    staffOnly: word('Only the owners and admins start topics in this section. You can reply to theirs.'),
    staffAction: word('Only an owner or admin of this community can do this.'),
    notYours: word('Only its writer can change this post.'),
    closeNotYours: word('Only its writer, an owner or an admin can close this topic.'),
    alreadyClosed: word('This topic is already closed.'),
    tellFirst: word('Anyone on the web can read this forum, with your name. Read that first, then post.'),
    title: word('Give your topic a title.'),
    words: word('Write something first.'),
    badQuote: word('The reply you quoted isn’t in this topic any more.'),
    photos: word('Photos are a list of pictures.'),
    sectionName: word('Give the section a name.'),
    tooManyPins: word('This section already has 2 pinned topics. Unpin one first.'),
    sameSection: word('This topic is already in that section.'),
};

/** A member's own text: control and hidden characters out, at most `max` characters, or a refusal over it. */
function text(value: unknown, max: number, field: string): string {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') throw new ForumRefusal(400, 'bad_request', `${field} is text.`);
    if (Array.from(value.trim()).length > max) throw new ForumRefusal(400, 'too_long', tr('At most {n} characters.', { n: max }));
    return cleanMemberText(value, max);
}

function linksAndMentions(words: string): void {
    if (!forumLinksFit(words)) throw new ForumRefusal(400, 'too_many_links', tr('A post can hold at most {n} links.', { n: FORUM_LIMITS.links }));
    if (!forumMentionsFit(words)) throw new ForumRefusal(400, 'too_many_mentions', tr('A post can mention at most {n} people.', { n: FORUM_LIMITS.mentions }));
}

/** The writer's app language, or null. */
const langOf = (raw: unknown): string | null => (isLang(raw) ? raw : null);

/** The photos a post brings: data URLs only, at most 3, held to a listing photo's checks, then stripped of their metadata. */
function forumPhotos(raw: unknown): string[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.some((p) => typeof p !== 'string' || !p.trim().startsWith('data:'))) {
        throw new ForumRefusal(400, 'bad_photos', FORUM_WORDS.photos);
    }
    if (raw.length > FORUM_LIMITS.photos) throw new ForumRefusal(400, 'too_many_photos', tr('At most {n} photos.', { n: FORUM_LIMITS.photos }));
    const photos = (raw as string[]).map((p) => p.trim());
    validatePostPhotos(photos);
    const refusal = photosRefusal(photos);
    if (refusal) throw photoRefusalError(refusal, POST_PHOTO_FORMAT_ERROR);
    return photos.map((p) => stripImageValue(p));
}

const isStaff = (pk: string) => {
    const role = nodeRoleOf(pk);
    return role === 'owner' || role === 'admin';
};
const newId = (prefix: string) => `${prefix}-${crypto.randomBytes(12).toString('hex')}`;
const nameOf = (pk: string) => getMember(db, pk)?.callsign ?? '';

// ── Rows and what an answer holds ───────────────────────────────────────────────────────────────────────────────

interface SectionRow { id: string; starter: string | null; name: string | null; about: string | null; position: number; starts: ForumSectionStarts; listed: number; archived_at: string | null }
interface TopicRow {
    id: string; section_id: string; title: string; writer_pubkey: string; place: string | null; lang: string | null; reply_count: number;
    last_activity_at: string; pinned_at: string | null; closed_at: string | null; closed_by: string | null; created_at: string;
}
interface PostRow {
    id: string; topic_id: string; number: number; writer_pubkey: string; words: string; quotes: number | null; lang: string | null;
    created_at: string; edited_at: string | null; removed_at: string | null; removed_by: string | null;
}

export interface ForumSection { id: string; starter: string | null; name: string | null; about: string | null; position: number; starts: ForumSectionStarts; listed: boolean; archived: boolean }
export interface ForumWriter { publicKey: string; name: string }
export interface ForumTopic {
    id: string; sectionId: string; title: string; writer: ForumWriter; place: string | null; lang: string | null; replyCount: number;
    lastActivityAt: string; createdAt: string; pinned: boolean; closed: string | null; removed: boolean;
}
export interface ForumPost {
    id: string; topicId: string; number: number; writer: ForumWriter; words: string; quotes: number | null; lang: string | null;
    createdAt: string; editedAt: string | null; removed: string | null; photos: number;
}

const sectionOut = (r: SectionRow): ForumSection => ({
    id: r.id, starter: r.starter, name: r.name, about: r.about, position: r.position, starts: r.starts, listed: r.listed === 1, archived: r.archived_at !== null,
});
const topicOut = (r: TopicRow & { opening_removed?: number }): ForumTopic => ({
    id: r.id, sectionId: r.section_id, title: r.title, writer: { publicKey: r.writer_pubkey, name: nameOf(r.writer_pubkey) }, place: r.place, lang: r.lang,
    replyCount: r.reply_count, lastActivityAt: r.last_activity_at, createdAt: r.created_at, pinned: r.pinned_at !== null, closed: r.closed_by,
    removed: !!r.opening_removed,
});
const photoCount = (postId: string) => (db.prepare('SELECT COUNT(*) AS n FROM forum_post_photos WHERE post_id = ?').get(postId) as { n: number }).n;
const postOut = (r: PostRow): ForumPost => ({
    id: r.id, topicId: r.topic_id, number: r.number, writer: { publicKey: r.writer_pubkey, name: nameOf(r.writer_pubkey) },
    words: r.removed_by ? '' : r.words, quotes: r.quotes, lang: r.lang, createdAt: r.created_at, editedAt: r.edited_at, removed: r.removed_by,
    photos: r.removed_by ? 0 : photoCount(r.id),
});

/** Leaves out what `reader` blocked: `col` names the writer's key column. */
const NOT_BLOCKED = (col: string) => `${col} NOT IN (SELECT blocked_pubkey FROM member_blocks WHERE owner_pubkey = @reader)`;
const OPENING_REMOVED = `(SELECT p.removed_by IS NOT NULL FROM forum_posts p WHERE p.topic_id = t.id AND p.number = 1) AS opening_removed`;

// ── Starter sections ────────────────────────────────────────────────────────────────────────────────────────────

let startersChecked = false;

/** Makes the starter sections once, on the main server, the first time it finds none (design §20). */
export function ensureForumStarters(now = Date.now()): void {
    if (startersChecked || getNodeRole() !== 'primary') return;
    db.transaction(() => {
        const made = db.prepare('SELECT 1 FROM node_config WHERE key = ?').get(FORUM_STARTERS_MADE_KEY);
        if (!made && !db.prepare('SELECT 1 FROM forum_sections LIMIT 1').get()) {
            const add = db.prepare('INSERT INTO forum_sections (id, starter, name, about, position, starts, listed, created_at) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?)');
            FORUM_STARTER_SECTIONS[getNodeProfile() === 'global' ? 'global' : 'local']
                .forEach((s, i) => add.run(newId('fs'), s.id, i, s.starts, s.listed ? 1 : 0, iso(now)));
        }
        if (!made) db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?)').run(FORUM_STARTERS_MADE_KEY, iso(now));
    })();
    startersChecked = true;
}

/** For tests: check again on the next read. */
export function resetForumStartersCheckForTests(): void {
    startersChecked = false;
}

// ── Reads ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What a list answer depends on, as a tag: the topics and sections (their count and newest stamp, which a standby's copy
 * moves too), members' names, the reader's own block list (its count and newest stamp: a block or an unblock moves one) and
 * whether they see archived sections. Same tag, same answer, so a list answers "not changed" (304) when nothing did.
 */
export function forumListTag(reader: string): string {
    const stamp = (sql: string, ...args: unknown[]) => {
        const r = db.prepare(sql).get(...args) as { n: number; u: string | null };
        return `${r.n}:${r.u ?? ''}`;
    };
    const parts = [
        reader,
        stamp('SELECT COUNT(*) AS n, MAX(updated_at) AS u FROM forum_topics'),
        stamp('SELECT COUNT(*) AS n, MAX(updated_at) AS u FROM forum_sections'),
        stamp('SELECT COUNT(*) AS n, MAX(updated_at) AS u FROM member_blocks WHERE owner_pubkey = ?', reader),
        getMembersVersion(),
        isStaff(reader) ? 'staff' : 'member',
    ].join('|');
    return crypto.createHash('sha256').update(parts).digest('hex').slice(0, 24);
}

function sectionRow(id: string): SectionRow | undefined {
    return db.prepare('SELECT * FROM forum_sections WHERE id = ?').get(id) as SectionRow | undefined;
}

/** The forum's front: its sections in order (owners and admins also see the archived ones), and the reader's told stamp. */
export function forumFront(reader: string): { sections: ForumSection[]; public: boolean; told: boolean } {
    ensureForumStarters();
    const staff = isStaff(reader);
    const rows = db.prepare(`SELECT * FROM forum_sections ${staff ? '' : 'WHERE archived_at IS NULL'} ORDER BY position, created_at, id`).all() as SectionRow[];
    return { sections: rows.map(sectionOut), public: getProfileSwitches().forumPublic, told: toldAt(reader) !== null };
}

/** Topics, pinned first and then the newest activity (@beanpool/core compareForumTopics), 30 a page. */
export function forumTopics(reader: string, opts: { sectionId?: string; offset: number }): { topics: ForumTopic[]; next: number | null } {
    ensureForumStarters();
    if (opts.sectionId !== undefined) {
        // An archived section is out of members' lists, by its id too; owners and admins still list it.
        const section = sectionRow(opts.sectionId);
        if (!section || (section.archived_at && !isStaff(reader))) throw new ForumRefusal(404, 'not_found', FORUM_WORDS.sectionNotFound);
    }
    const where = [
        "COALESCE(t.closed_by, '') != 'removed'",
        NOT_BLOCKED('t.writer_pubkey'),
        opts.sectionId !== undefined ? 't.section_id = @section' : 't.section_id IN (SELECT id FROM forum_sections WHERE archived_at IS NULL)',
    ];
    const rows = db.prepare(`
        SELECT t.*, ${OPENING_REMOVED} FROM forum_topics t WHERE ${where.join(' AND ')}
         ORDER BY (t.pinned_at IS NOT NULL) DESC, t.last_activity_at DESC, t.id ASC LIMIT @limit OFFSET @offset`)
        .all({ reader, section: opts.sectionId ?? null, limit: FORUM_LIMITS.topicsPerPage + 1, offset: opts.offset }) as (TopicRow & { opening_removed: number })[];
    const more = rows.length > FORUM_LIMITS.topicsPerPage;
    return { topics: rows.slice(0, FORUM_LIMITS.topicsPerPage).map(topicOut), next: more ? opts.offset + FORUM_LIMITS.topicsPerPage : null };
}

/** A topic the reader may see: not gone, not by someone they blocked. */
function visibleTopic(reader: string | null, id: string): TopicRow {
    const row = db.prepare(`SELECT t.* FROM forum_topics t WHERE t.id = @id AND COALESCE(t.closed_by, '') != 'removed'
        ${reader ? `AND ${NOT_BLOCKED('t.writer_pubkey')}` : ''}`).get({ id, reader }) as TopicRow | undefined;
    if (!row) throw new ForumRefusal(404, 'not_found', FORUM_WORDS.notFound);
    return row;
}

/** One topic and its posts in order, 30 at a time after post number `after`; posts by someone the reader blocked left out. */
export function forumTopic(reader: string, id: string, after: number): { topic: ForumTopic; posts: ForumPost[]; next: number | null } {
    const t = visibleTopic(reader, id);
    const opening = db.prepare('SELECT removed_by FROM forum_posts WHERE topic_id = ? AND number = 1').get(id) as { removed_by: string | null } | undefined;
    const rows = db.prepare(`SELECT * FROM forum_posts WHERE topic_id = @id AND number > @after AND ${NOT_BLOCKED('writer_pubkey')} ORDER BY number LIMIT @limit`)
        .all({ id, after, reader, limit: FORUM_LIMITS.postsPerPage + 1 }) as PostRow[];
    const more = rows.length > FORUM_LIMITS.postsPerPage;
    const posts = rows.slice(0, FORUM_LIMITS.postsPerPage);
    return {
        topic: topicOut({ ...t, opening_removed: opening?.removed_by ? 1 : 0 }),
        posts: posts.map(postOut),
        next: more ? posts[posts.length - 1].number : null,
    };
}

/** One of a post's photos as its data URL, for a reader who may see the post; null when there is none. */
export function forumPhoto(reader: string, postId: string, n: number): string | null {
    const post = db.prepare('SELECT topic_id, writer_pubkey, removed_by FROM forum_posts WHERE id = ?').get(postId) as { topic_id: string; writer_pubkey: string; removed_by: string | null } | undefined;
    if (!post || post.removed_by) return null;
    visibleTopic(reader, post.topic_id);
    if (db.prepare('SELECT 1 FROM member_blocks WHERE owner_pubkey = ? AND blocked_pubkey = ?').get(reader, post.writer_pubkey)) return null;
    return (db.prepare('SELECT photo_data FROM forum_post_photos WHERE post_id = ? AND order_num = ?').get(postId, n) as { photo_data: string } | undefined)?.photo_data ?? null;
}

// ── Told that the forum is public ───────────────────────────────────────────────────────────────────────────────

function toldAt(member: string): string | null {
    return (db.prepare('SELECT told_public_at FROM forum_members WHERE member_pubkey = ?').get(member) as { told_public_at: string | null } | undefined)?.told_public_at ?? null;
}

/** The member agreed to the sheet that says anyone on the web can read the forum with their name. Once; kept. */
export function markForumTold(member: string, now = Date.now()): void {
    assertPlainTablesWritable();
    if (toldAt(member)) return;
    db.prepare(`INSERT INTO forum_members (member_pubkey, told_public_at) VALUES (?, ?)
        ON CONFLICT(member_pubkey) DO UPDATE SET told_public_at = excluded.told_public_at`).run(member, iso(now));
}

/** On a public forum, no post until the member was told (design §5): the server holds it, so no app can skip the telling. */
function assertTold(member: string): void {
    if (getProfileSwitches().forumPublic && !toldAt(member)) throw new ForumRefusal(409, 'tell_first', FORUM_WORDS.tellFirst);
}

// ── Writing ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** 10 topics or 100 replies in any 24 hours, removed ones counted; owners and admins the "Owner and admin limit". */
function assertForumDay(member: string, kind: 'topics' | 'replies', now: number): void {
    const limit = ownerAdminLimit(member) ?? FORUM_DAY_LIMITS.known[kind];
    const since = iso(now - DAY_MS);
    const used = kind === 'topics'
        ? (db.prepare('SELECT COUNT(*) AS n FROM forum_topics WHERE writer_pubkey = ? AND created_at > ?').get(member, since) as { n: number }).n
        : (db.prepare('SELECT COUNT(*) AS n FROM forum_posts WHERE writer_pubkey = ? AND number > 1 AND created_at > ?').get(member, since) as { n: number }).n;
    if (used < limit) return;
    throw kind === 'topics'
        ? new ForumRefusal(429, 'topics_per_day', tr('You can start {n} topics in any 24 hours. Try again tomorrow.', { n: limit }))
        : new ForumRefusal(429, 'replies_per_day', tr('You can write {n} replies in any 24 hours. Try again tomorrow.', { n: limit }));
}

function storePhotos(member: string, postId: string, photos: string[], now: number): void {
    const add = db.prepare('INSERT INTO forum_post_photos (post_id, order_num, photo_data, bytes) VALUES (?, ?, ?, ?)');
    photos.forEach((p, i) => add.run(postId, i, p, incomingPhotosBytes([p])));
    if (photos.length > 0) recordStoredPhotoBytes(member, incomingPhotosBytes(photos), now);
}

/** What every write of words checks first: the main server, a member who isn't muted. Removing or closing their own takes no
 *  words to anyone, so a muted member may still do it (assertPlainTablesWritable alone). */
function writable(member: string, now: number): void {
    assertPlainTablesWritable();
    assertNotMuted(member, now);
}

export interface TopicInput { sectionId?: unknown; title?: unknown; words?: unknown; place?: unknown; lang?: unknown; photos?: unknown }

/** A new topic: its row and its opening words as post number 1. */
export function startForumTopic(member: string, raw: TopicInput, now = Date.now()): { topic: ForumTopic; post: ForumPost } {
    writable(member, now);
    ensureForumStarters(now);
    const section = typeof raw.sectionId === 'string' ? sectionRow(raw.sectionId) : undefined;
    if (!section || section.archived_at) throw new ForumRefusal(404, 'not_found', FORUM_WORDS.sectionNotFound);
    if (section.starts === 'staff' && !isStaff(member)) throw new ForumRefusal(403, 'staff_only', FORUM_WORDS.staffOnly);
    assertTold(member);
    const title = text(raw.title, FORUM_LIMITS.title, 'title').replace(/\s+/g, ' ');
    const words = text(raw.words, FORUM_LIMITS.opening, 'words');
    const place = text(raw.place, FORUM_LIMITS.place, 'place').replace(/\s+/g, ' ') || null;
    if (!title) throw new ForumRefusal(400, 'title_required', FORUM_WORDS.title);
    if (!words) throw new ForumRefusal(400, 'words_required', FORUM_WORDS.words);
    linksAndMentions(words);
    const photos = forumPhotos(raw.photos);
    assertForumDay(member, 'topics', now);
    if (photos.length > 0) assertMayStorePhotoBytes(member, incomingPhotosBytes(photos), now);
    const topicId = newId('ft');
    const postId = newId('fp');
    const at = iso(now);
    const lang = langOf(raw.lang);
    db.transaction(() => {
        db.prepare(`INSERT INTO forum_topics (id, section_id, title, writer_pubkey, place, lang, reply_count, last_activity_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(topicId, section.id, title, member, place, lang, at, at);
        db.prepare(`INSERT INTO forum_posts (id, topic_id, number, writer_pubkey, words, lang, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)`)
            .run(postId, topicId, member, words, lang, at);
        storePhotos(member, postId, photos, now);
    })();
    return { topic: forumTopic(member, topicId, 0).topic, post: postOut(postRow(postId)!) };
}

const postRow = (id: string) => db.prepare('SELECT * FROM forum_posts WHERE id = ?').get(id) as PostRow | undefined;

export interface ReplyInput { words?: unknown; quotes?: unknown; lang?: unknown; photos?: unknown }

/** A reply at the end of an open topic, quoting at most one earlier post that is still there. */
export function replyInForum(member: string, topicId: string, raw: ReplyInput, now = Date.now()): ForumPost {
    writable(member, now);
    const topic = visibleTopic(member, topicId);
    if (topic.closed_at || sectionRow(topic.section_id)?.archived_at) throw new ForumRefusal(409, 'closed', FORUM_WORDS.closed);
    assertTold(member);
    const words = text(raw.words, FORUM_LIMITS.reply, 'words');
    if (!words) throw new ForumRefusal(400, 'words_required', FORUM_WORDS.words);
    linksAndMentions(words);
    let quotes: number | null = null;
    if (raw.quotes !== undefined && raw.quotes !== null) {
        const q = raw.quotes;
        const there = Number.isInteger(q) && db.prepare('SELECT 1 FROM forum_posts WHERE topic_id = ? AND number = ? AND removed_by IS NULL').get(topicId, q);
        if (!there) throw new ForumRefusal(400, 'bad_quote', FORUM_WORDS.badQuote);
        quotes = q as number;
    }
    const photos = forumPhotos(raw.photos);
    assertForumDay(member, 'replies', now);
    if (photos.length > 0) assertMayStorePhotoBytes(member, incomingPhotosBytes(photos), now);
    const id = newId('fp');
    const at = iso(now);
    db.transaction(() => {
        const n = (db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM forum_posts WHERE topic_id = ?').get(topicId) as { n: number }).n;
        db.prepare(`INSERT INTO forum_posts (id, topic_id, number, writer_pubkey, words, quotes, lang, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, topicId, n, member, words, quotes, langOf(raw.lang), at);
        db.prepare('UPDATE forum_topics SET reply_count = reply_count + 1, last_activity_at = ? WHERE id = ?').run(at, topicId);
        storePhotos(member, id, photos, now);
    })();
    return postOut(postRow(id)!);
}

/** The writer's own post, still there, in a topic they may see; or a refusal. */
function ownPost(member: string, postId: string): { post: PostRow; topic: TopicRow } {
    const post = postRow(postId);
    if (!post || post.removed_by) throw new ForumRefusal(404, 'not_found', FORUM_WORDS.postNotFound);
    const topic = visibleTopic(member, post.topic_id);
    if (post.writer_pubkey !== member) throw new ForumRefusal(403, 'not_yours', FORUM_WORDS.notYours);
    return { post, topic };
}

/** The writer edits their own post while the topic is open; the wording before is kept 30 days for moderators. */
export function editForumPost(member: string, postId: string, raw: { words?: unknown; title?: unknown }, now = Date.now()): { topic: ForumTopic; post: ForumPost } {
    writable(member, now);
    const { post, topic } = ownPost(member, postId);
    if (topic.closed_at) throw new ForumRefusal(409, 'closed', FORUM_WORDS.closed);
    const words = text(raw.words, post.number === 1 ? FORUM_LIMITS.opening : FORUM_LIMITS.reply, 'words');
    if (!words) throw new ForumRefusal(400, 'words_required', FORUM_WORDS.words);
    linksAndMentions(words);
    let title: string | null = null;
    if (raw.title !== undefined && post.number === 1) {
        title = text(raw.title, FORUM_LIMITS.title, 'title').replace(/\s+/g, ' ');
        if (!title) throw new ForumRefusal(400, 'title_required', FORUM_WORDS.title);
    }
    const at = iso(now);
    db.transaction(() => {
        db.prepare('INSERT OR REPLACE INTO forum_post_edits (post_id, edited_at, words, title) VALUES (?, ?, ?, ?)')
            .run(postId, at, post.words, title !== null && title !== topic.title ? topic.title : null);
        db.prepare('UPDATE forum_posts SET words = ?, edited_at = ? WHERE id = ?').run(words, at, postId);
        if (title !== null && title !== topic.title) db.prepare('UPDATE forum_topics SET title = ? WHERE id = ?').run(title, topic.id);
    })();
    return { topic: forumTopic(member, topic.id, 0).topic, post: postOut(postRow(postId)!) };
}

/** A post's words blanked, its photos and earlier wordings deleted with tombstones: the row stays as a marker. */
function blankPost(postId: string, by: 'writer' | 'moderator' | 'account', at: string): void {
    db.prepare(`UPDATE forum_posts SET words = '', removed_at = COALESCE(removed_at, ?), removed_by = COALESCE(removed_by, ?) WHERE id = ?`).run(at, by, postId);
    deletePlainRows('forum_post_photos', 'post_id = ?', postId);
    deletePlainRows('forum_post_edits', 'post_id = ?', postId);
}

/** Whether anyone but the topic's writer has a reply in it still there. */
const othersReplied = (topic: TopicRow) =>
    !!db.prepare('SELECT 1 FROM forum_posts WHERE topic_id = ? AND number > 1 AND writer_pubkey != ? AND removed_by IS NULL').get(topic.id, topic.writer_pubkey);

/**
 * A topic with its writer's words gone: listed nowhere when nobody else replied ('removed'); otherwise its title blanked
 * ("A removed topic"), closed, the replies staying.
 */
function blankTopic(topic: TopicRow, at: string): void {
    const gone = !othersReplied(topic);
    db.prepare(`UPDATE forum_topics SET title = '', place = NULL, pinned_at = CASE WHEN ? THEN NULL ELSE pinned_at END,
        closed_at = COALESCE(closed_at, ?), closed_by = CASE WHEN ? THEN 'removed' ELSE COALESCE(closed_by, 'writer') END WHERE id = ?`)
        .run(gone ? 1 : 0, at, gone ? 1 : 0, topic.id);
}

/** The writer removes their own post: a reply leaves a marker; an opening post takes its topic's title with it. */
export function removeForumPost(member: string, postId: string, now = Date.now()): void {
    assertPlainTablesWritable();
    const { post, topic } = ownPost(member, postId);
    const at = iso(now);
    db.transaction(() => {
        blankPost(post.id, 'writer', at);
        if (post.number === 1) {
            blankTopic(topic, at);
            // Gone with nobody else's reply: the writer's own replies under it go too.
            if (db.prepare("SELECT closed_by FROM forum_topics WHERE id = ?").pluck().get(topic.id) === 'removed') {
                for (const p of db.prepare('SELECT id FROM forum_posts WHERE topic_id = ? AND removed_by IS NULL').pluck().all(topic.id) as string[]) blankPost(p, 'writer', at);
            }
        }
        db.prepare('UPDATE forum_topics SET reply_count = (SELECT COUNT(*) FROM forum_posts WHERE topic_id = ? AND number > 1 AND removed_by IS NULL) WHERE id = ?').run(topic.id, topic.id);
    })();
}

/** Its writer, an owner or an admin closes a topic: still readable, no new replies. */
export function closeForumTopic(member: string, topicId: string, now = Date.now()): ForumTopic {
    assertPlainTablesWritable();
    const topic = visibleTopic(member, topicId);
    const staff = isStaff(member);
    if (topic.writer_pubkey !== member && !staff) throw new ForumRefusal(403, 'not_yours', FORUM_WORDS.closeNotYours);
    if (topic.closed_at) throw new ForumRefusal(409, 'already_closed', FORUM_WORDS.alreadyClosed);
    db.prepare('UPDATE forum_topics SET closed_at = ?, closed_by = ? WHERE id = ?').run(iso(now), topic.writer_pubkey === member ? 'writer' : 'moderator', topicId);
    return forumTopic(member, topicId, 0).topic;
}

function staffOnly(member: string, now: number): void {
    writable(member, now);
    if (!isStaff(member)) throw new ForumRefusal(403, 'staff_only', FORUM_WORDS.staffAction);
}

const pinsIn = (sectionId: string, except: string) =>
    (db.prepare('SELECT COUNT(*) AS n FROM forum_topics WHERE section_id = ? AND pinned_at IS NOT NULL AND id != ?').get(sectionId, except) as { n: number }).n;

/** An owner or admin pins a topic to the top of its section (2 a section, no clock) or unpins it. */
export function pinForumTopic(member: string, topicId: string, pinned: boolean, now = Date.now()): ForumTopic {
    staffOnly(member, now);
    const topic = visibleTopic(member, topicId);
    if (pinned && !topic.pinned_at) {
        if (pinsIn(topic.section_id, topic.id) >= FORUM_LIMITS.pinsPerSection) throw new ForumRefusal(409, 'too_many_pins', FORUM_WORDS.tooManyPins);
        db.prepare('UPDATE forum_topics SET pinned_at = ? WHERE id = ?').run(iso(now), topicId);
    } else if (!pinned && topic.pinned_at) {
        db.prepare('UPDATE forum_topics SET pinned_at = NULL WHERE id = ?').run(topicId);
    }
    return forumTopic(member, topicId, 0).topic;
}

/** An owner or admin moves a topic to another section; it stays pinned only where that section has room. */
export function moveForumTopic(member: string, topicId: string, sectionId: unknown, now = Date.now()): ForumTopic {
    staffOnly(member, now);
    const topic = visibleTopic(member, topicId);
    const to = typeof sectionId === 'string' ? sectionRow(sectionId) : undefined;
    if (!to || to.archived_at) throw new ForumRefusal(404, 'not_found', FORUM_WORDS.sectionNotFound);
    if (to.id === topic.section_id) throw new ForumRefusal(409, 'same_section', FORUM_WORDS.sameSection);
    const keepPin = topic.pinned_at !== null && pinsIn(to.id, topic.id) < FORUM_LIMITS.pinsPerSection;
    db.prepare('UPDATE forum_topics SET section_id = ?, pinned_at = ? WHERE id = ?').run(to.id, keepPin ? topic.pinned_at : null, topicId);
    return forumTopic(member, topicId, 0).topic;
}

// ── Sections ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SectionInput { name?: unknown; about?: unknown; starts?: unknown; listed?: unknown; position?: unknown; archived?: unknown }

const activeSections = () => (db.prepare('SELECT COUNT(*) AS n FROM forum_sections WHERE archived_at IS NULL').get() as { n: number }).n;
const tooManySections = () => new ForumRefusal(409, 'too_many_sections', tr('A forum has at most {n} sections. Archive one first.', { n: FORUM_LIMITS.sections }));

function startsOf(raw: unknown): ForumSectionStarts {
    if (raw === 'members' || raw === 'staff') return raw;
    throw new ForumRefusal(400, 'bad_request', "starts is 'members' or 'staff'.");
}
function boolOf(raw: unknown, field: string): boolean {
    if (typeof raw === 'boolean') return raw;
    throw new ForumRefusal(400, 'bad_request', `${field} is true or false.`);
}

/** An owner or admin makes a section, at the end of the list. */
export function createForumSection(member: string, raw: SectionInput, now = Date.now()): ForumSection {
    staffOnly(member, now);
    ensureForumStarters(now);
    const name = text(raw.name, FORUM_LIMITS.sectionName, 'name').replace(/\s+/g, ' ');
    if (!name) throw new ForumRefusal(400, 'name_required', FORUM_WORDS.sectionName);
    const about = text(raw.about, FORUM_LIMITS.sectionAbout, 'about') || null;
    const starts = raw.starts === undefined ? 'members' : startsOf(raw.starts);
    const listed = raw.listed === undefined ? false : boolOf(raw.listed, 'listed');
    if (activeSections() >= FORUM_LIMITS.sections) throw tooManySections();
    const id = newId('fs');
    const position = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM forum_sections').get() as { p: number }).p;
    db.prepare('INSERT INTO forum_sections (id, starter, name, about, position, starts, listed, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)')
        .run(id, name, about, position, starts, listed ? 1 : 0, iso(now));
    return sectionOut(sectionRow(id)!);
}

/** An owner or admin renames, describes, orders, opens or closes to members, or archives a section. A rename clears its starter. */
export function editForumSection(member: string, id: string, raw: SectionInput, now = Date.now()): ForumSection {
    staffOnly(member, now);
    const row = sectionRow(id);
    if (!row) throw new ForumRefusal(404, 'not_found', FORUM_WORDS.sectionNotFound);
    const set: string[] = [];
    const args: unknown[] = [];
    if (raw.name !== undefined) {
        const name = text(raw.name, FORUM_LIMITS.sectionName, 'name').replace(/\s+/g, ' ');
        if (!name) throw new ForumRefusal(400, 'name_required', FORUM_WORDS.sectionName);
        set.push('starter = NULL', 'name = ?');
        args.push(name);
    }
    if (raw.about !== undefined) { set.push('about = ?'); args.push(text(raw.about, FORUM_LIMITS.sectionAbout, 'about') || null); }
    if (raw.starts !== undefined) { set.push('starts = ?'); args.push(startsOf(raw.starts)); }
    if (raw.listed !== undefined) { set.push('listed = ?'); args.push(boolOf(raw.listed, 'listed') ? 1 : 0); }
    if (raw.position !== undefined) {
        if (!Number.isInteger(raw.position) || (raw.position as number) < 0 || (raw.position as number) > 999) throw new ForumRefusal(400, 'bad_request', 'position is a whole number, 0 to 999.');
        set.push('position = ?');
        args.push(raw.position);
    }
    if (raw.archived !== undefined) {
        const archived = boolOf(raw.archived, 'archived');
        if (!archived && row.archived_at && activeSections() >= FORUM_LIMITS.sections) throw tooManySections();
        set.push('archived_at = ?');
        args.push(archived ? (row.archived_at ?? iso(now)) : null);
    }
    if (set.length > 0) db.prepare(`UPDATE forum_sections SET ${set.join(', ')} WHERE id = ?`).run(...args, id);
    return sectionOut(sectionRow(id)!);
}

// ── A member leaving, and the tidy-up ───────────────────────────────────────────────────────────────────────────

/**
 * An account deleted or removed: every post of theirs blanked as a marker (removed by 'account'), each topic they started
 * blanked as its writer's removal blanks it, their photos, earlier wordings and told stamp deleted with tombstones (design
 * §3). The rows' stamps move, so a standby's next copy blanks them there too. Call inside the removal's transaction.
 */
export function dropForumOf(member: string, now = Date.now()): void {
    const at = iso(now);
    const posts = db.prepare('SELECT id, topic_id FROM forum_posts WHERE writer_pubkey = ?').all(member) as { id: string; topic_id: string }[];
    for (const p of posts) {
        db.prepare(`UPDATE forum_posts SET words = '', removed_at = COALESCE(removed_at, ?), removed_by = COALESCE(removed_by, 'account') WHERE id = ?`).run(at, p.id);
    }
    deletePlainRows('forum_post_photos', 'post_id IN (SELECT id FROM forum_posts WHERE writer_pubkey = ?)', member);
    deletePlainRows('forum_post_edits', 'post_id IN (SELECT id FROM forum_posts WHERE writer_pubkey = ?)', member);
    for (const topic of db.prepare('SELECT * FROM forum_topics WHERE writer_pubkey = ?').all(member) as TopicRow[]) blankTopic(topic, at);
    for (const topicId of new Set(posts.map((p) => p.topic_id))) {
        db.prepare('UPDATE forum_topics SET reply_count = (SELECT COUNT(*) FROM forum_posts WHERE topic_id = ? AND number > 1 AND removed_by IS NULL) WHERE id = ?').run(topicId, topicId);
    }
    deletePlainRows('forum_members', 'member_pubkey = ?', member);
}

/**
 * The wording before an edit, 30 days after, on the main server (a standby's own age rule takes its copy: the manifest's
 * `agedOut`, with no tombstone). Returns how many went.
 */
export function tidyForumEdits(now = Date.now()): number {
    if (getNodeRole() !== 'primary') return 0;
    return db.prepare('DELETE FROM forum_post_edits WHERE edited_at < ?').run(iso(now - 30 * DAY_MS)).changes;
}

let tidyTimer: NodeJS.Timeout | null = null;
export function startTidyingForumEdits(everyMs = HOUR_MS): void {
    if (tidyTimer) return;
    tidyTimer = setInterval(() => {
        try { tidyForumEdits(); } catch { /* the next hour tries again */ }
    }, everyMs);
    tidyTimer.unref?.();
}
