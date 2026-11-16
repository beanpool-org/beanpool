/**
 * The worldwide community's forum as anyone on the web reads it (slice F7; scratch/fable-design/DESIGN-forums-fable.md §4,
 * §5, §7, §15; Marty's answer to Q2, 14 Nov 2026). routes/forum-public.ts answers it as JSON and as plain HTML pages.
 *
 * - **Where.** Only where the forum is on and public (`forum` and `forumPublic`: the global community), and not in a private
 *   preview (config/private-preview.ts: it shows visitors nothing). Anywhere else every public read answers "not found",
 *   robots.txt names no sitemap, and nothing here stamps anything: a local community's forum is for its members. What is
 *   written during a preview goes public by the sweep once it ends (members were told it would: engine/forum.ts assertTold).
 * - **Public from.** A post's `public_from` is empty until its writer is known in this forum (engine/forum-moderation.ts
 *   forumNewness: a role, a first topic a moderator OK'd, or their new-account days over) and it is in a section every member
 *   reads (no group's, so never Builders). Stamped when a known writer posts, when a first look's OK makes a writer known, and
 *   by a sweep every hour for the rest (new-account days that ran out, a role given). An unsigned answer holds only posts
 *   where it is set, and of those only ones still up: never removed, never hidden while moderators look. A waiting first
 *   topic is no topic (forum_waiting), so nothing here can reach it.
 * - **A topic** is public when its opening post is: so a new person's topic, a hidden or removed one, and one blanked by
 *   its writer are not found, by its address too. Its reply count and last activity are of its public posts only.
 * - **What an answer holds** is exactly @beanpool/core FORUM_PUBLIC_FIELDS: a writer is a name and the community label they
 *   switched on (slice F10), never a key, a picture, a profile, an area. No proof yet (slice F11 adds it).
 * - **Search engines** (Q2): a topic may be listed once its opening post has been public for 2 days and it is in a listed
 *   section; any section its owners mark unlisted never; a group's section is never public at all. "Introduce yourself" never,
 *   by a mark no edit removes: the starter a section was made as, which a rename keeps (engine/forum.ts editForumSection, which
 *   also refuses to list it), and `never_listed` on a topic moved out of it (moveForumTopic). `listed` alone is not trusted.
 *
 * Reads only, but for the stamp, which the main server alone writes (a standby gets it in its copy).
 */
import { FORUM_LIMITS, FORUM_STARTER_SECTIONS, FORUM_TIMES, type ForumWriterLabel } from '@beanpool/core';
import { getMember } from '@beanpool/engine';
import { db } from '../db/db.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { isPrivatePreview } from '../config/private-preview.js';
import { getNodeRole } from './sync.js';
import { knownWriters } from './forum-moderation.js';
import { forumLabelsOf } from './membership-note.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Whether anyone on the web reads this community's forum: the forum on, and public (the global community), and no private
 * preview, which shows visitors nothing (as the share page: engine/peek-tickets.ts outsideSharingOn). Every public page, the
 * JSON, the photos, the sitemap, robots.txt's lines and the stamp ask this.
 */
export function forumPublicOn(): boolean {
    const s = getProfileSwitches();
    return s.forum && s.forumPublic && !isPrivatePreview();
}

/**
 * The starter sections search engines never list (Q2: "never Introduce yourself"), by the starter each was made as. A section
 * keeps its starter through a rename, so this holds whatever its owners call it.
 */
export const FORUM_NEVER_LISTED_STARTERS: readonly string[] = Object.freeze(FORUM_STARTER_SECTIONS.global.filter((s) => !s.listed).map((s) => s.id));
/** Whether a section made as this starter is one search engines never list. */
export const forumStarterNeverListed = (starter: string | null | undefined): boolean => !!starter && FORUM_NEVER_LISTED_STARTERS.includes(starter);
/** SQL: the section (alias `s`) may be listed: marked listed, and not made as a starter that never is. Ids are core's constants. */
const SECTION_MAY_BE_LISTED = (s: string) =>
    `${s}.listed = 1 AND COALESCE(${s}.starter, '') NOT IN (${FORUM_NEVER_LISTED_STARTERS.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ')})`;

// ── Public from ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A post (columns of forum_posts, unqualified) not yet stamped, still up, in a section every member reads. */
const STAMPABLE = `public_from IS NULL AND removed_by IS NULL
    AND topic_id IN (SELECT t.id FROM forum_topics t JOIN forum_sections s ON s.id = t.section_id WHERE s.group_id IS NULL)`;

/**
 * Stamps `public_from` on every post still waiting for it whose writer is known now, `only` that writer's when given. On the
 * main server of a public forum only; elsewhere nothing. The number of posts stamped.
 */
export function stampForumPublicFrom(only: string | null = null, now = Date.now()): number {
    if (!forumPublicOn() || getNodeRole() !== 'primary') return 0;
    const writers = (only === null
        ? db.prepare(`SELECT DISTINCT writer_pubkey FROM forum_posts WHERE ${STAMPABLE}`).pluck().all()
        : db.prepare(`SELECT DISTINCT writer_pubkey FROM forum_posts WHERE writer_pubkey = ? AND ${STAMPABLE}`).pluck().all(only)) as string[];
    if (writers.length === 0) return 0;
    const known = knownWriters(writers, now);
    const stamp = db.prepare(`UPDATE forum_posts SET public_from = ? WHERE writer_pubkey = ? AND ${STAMPABLE}`);
    let stamped = 0;
    db.transaction(() => {
        for (const w of writers) if (known.get(w)) stamped += stamp.run(iso(now), w).changes;
    })();
    return stamped;
}

/** The hourly sweep: writers whose new-account days ran out, or who were given a role, since they last wrote. */
export function startStampingForumPublicFrom(everyMs = HOUR_MS): void {
    const run = () => {
        try { stampForumPublicFrom(); } catch (e: any) { console.warn('[Forum] Stamping public posts failed:', e?.message || e); }
    };
    run();
    setInterval(run, everyMs).unref();
}

// ── What anyone may read ────────────────────────────────────────────────────────────────────────────────────────

/** A post (alias `p`) anyone on the web may read: stamped, still up, not hidden while moderators look. */
const PUBLIC_POST = (p: string) => `${p}.public_from IS NOT NULL AND ${p}.removed_by IS NULL AND ${p}.hidden_by_reports_at IS NULL`;
/** A topic (alias `t`) anyone may read: not gone, in no group's section, its opening post public. */
const PUBLIC_TOPIC = (t: string) => `COALESCE(${t}.closed_by, '') != 'removed'
    AND ${t}.section_id IN (SELECT id FROM forum_sections WHERE group_id IS NULL)
    AND EXISTS (SELECT 1 FROM forum_posts o WHERE o.topic_id = ${t}.id AND o.number = 1 AND ${PUBLIC_POST('o')})`;
/** In a list: and its section not archived. */
const LISTED_TOPIC = (t: string) => `${PUBLIC_TOPIC(t)} AND ${t}.section_id IN (SELECT id FROM forum_sections WHERE group_id IS NULL AND archived_at IS NULL)`;

/** A section as anyone reads it (FORUM_PUBLIC_FIELDS.section). `name` is null while it is a starter's own (forumSectionName). */
export interface ForumPublicSection { id: string; starter: string | null; name: string | null; about: string | null; position: number; topicCount: number }
/** A writer as anyone reads them: a name, and the label they chose to show (slice F10), else null. */
export interface ForumPublicWriter { name: string; community: ForumWriterLabel | null }
export interface ForumPublicTopic {
    id: string; sectionId: string; title: string; writer: ForumPublicWriter; createdAt: string; lastActivityAt: string; replyCount: number;
    pinned: boolean;
    /** 'writer', 'moderator' or 'quiet' (180 days without a reply): readable, taking no replies; null while open. */
    closed: string | null;
    place: string | null; lang: string | null;
    /** Search engines may list it (Q2): 2 days public, in a listed section. */
    indexable: boolean;
}
export interface ForumPublicPost {
    id: string; topicId: string; number: number; writer: ForumPublicWriter; words: string;
    /** The number of the earlier post it quotes, only when that post is public too; else null. */
    quotes: number | null;
    createdAt: string; edited: boolean;
    /** How many photos it holds: each at /api/forum/photos/<id>/<0..n-1>. */
    photos: number;
    lang: string | null;
}

interface SectionRow { id: string; starter: string | null; name: string | null; about: string | null; position: number; listed: number; archived_at: string | null; topic_count: number }
interface TopicRow {
    id: string; section_id: string; title: string; writer_pubkey: string; place: string | null; lang: string | null; pinned_at: string | null;
    closed_by: string | null; created_at: string; public_replies: number; public_last: string | null; opening_public_from: string; listed: number; archived_at: string | null;
    never_listed: number; section_starter: string | null;
}
interface PostRow { id: string; topic_id: string; number: number; writer_pubkey: string; words: string; public_quotes: number | null; created_at: string; edited_at: string | null; lang: string | null; photo_count: number }

function writersOf(keys: readonly string[]): (pk: string) => ForumPublicWriter {
    const labels = forumLabelsOf(keys);
    return (pk) => ({ name: getMember(db, pk)?.callsign ?? '', community: labels.get(pk) ?? null });
}

const SECTION_COLUMNS = `s.id, s.starter, s.name, s.about, s.position, s.listed, s.archived_at,
    (SELECT COUNT(*) FROM forum_topics t WHERE t.section_id = s.id AND ${PUBLIC_TOPIC('t')}) AS topic_count`;
// A renamed starter keeps its starter in the row (Q2's mark) but reads as typed: `starter` null once it has a name, as before.
const sectionOut = (r: SectionRow): ForumPublicSection => ({
    id: r.id, starter: r.name === null ? r.starter : null, name: r.name, about: r.about, position: r.position, topicCount: r.topic_count,
});
/** Search engines may list a section's page: marked listed, not archived, and not made as a starter that never is. */
const sectionIndexable = (r: { listed: number; starter: string | null; archived_at: string | null }): boolean =>
    r.listed === 1 && !r.archived_at && !forumStarterNeverListed(r.starter);

const TOPIC_COLUMNS = `t.id, t.section_id, t.title, t.writer_pubkey, t.place, t.lang, t.pinned_at, t.closed_by, t.created_at, t.never_listed,
    (SELECT COUNT(*) FROM forum_posts r WHERE r.topic_id = t.id AND r.number > 1 AND ${PUBLIC_POST('r')}) AS public_replies,
    (SELECT MAX(r.created_at) FROM forum_posts r WHERE r.topic_id = t.id AND ${PUBLIC_POST('r')}) AS public_last,
    (SELECT o.public_from FROM forum_posts o WHERE o.topic_id = t.id AND o.number = 1) AS opening_public_from,
    s.listed, s.archived_at, s.starter AS section_starter`;

/**
 * Search engines may list a topic (Q2): its section may be listed (sectionIndexable), it was never moved out of one that never
 * is, and its opening post has been public for 2 days.
 */
export function forumTopicIndexable(
    r: { listed: number; archived_at: string | null; section_starter: string | null; never_listed: number; opening_public_from: string }, now = Date.now(),
): boolean {
    return sectionIndexable({ listed: r.listed, starter: r.section_starter, archived_at: r.archived_at }) && r.never_listed !== 1
        && now - Date.parse(r.opening_public_from) >= FORUM_TIMES.indexAfterDays * DAY_MS;
}

const topicOut = (r: TopicRow, writer: (pk: string) => ForumPublicWriter, now: number): ForumPublicTopic => ({
    id: r.id, sectionId: r.section_id, title: r.title, writer: writer(r.writer_pubkey), createdAt: r.created_at,
    lastActivityAt: r.public_last ?? r.created_at, replyCount: r.public_replies, pinned: r.pinned_at !== null,
    closed: r.closed_by, place: r.place, lang: r.lang, indexable: forumTopicIndexable(r, now),
});

function topicsWhere(where: string, params: Record<string, unknown>, offset: number, now: number): { topics: ForumPublicTopic[]; next: number | null } {
    const rows = db.prepare(`SELECT ${TOPIC_COLUMNS} FROM forum_topics t JOIN forum_sections s ON s.id = t.section_id
        WHERE ${LISTED_TOPIC('t')} AND ${where}
        ORDER BY (t.pinned_at IS NOT NULL) DESC, t.last_activity_at DESC, t.id ASC LIMIT @limit OFFSET @offset`)
        .all({ ...params, limit: FORUM_LIMITS.topicsPerPage + 1, offset }) as TopicRow[];
    const page = rows.slice(0, FORUM_LIMITS.topicsPerPage);
    const writer = writersOf(page.map((r) => r.writer_pubkey));
    return { topics: page.map((r) => topicOut(r, writer, now)), next: rows.length > FORUM_LIMITS.topicsPerPage ? offset + FORUM_LIMITS.topicsPerPage : null };
}

/** The forum's front: its sections in order (no group's, no archived), and the newest topics across them, 30 a page. */
export function publicForumFront(offset = 0, now = Date.now()): { sections: ForumPublicSection[]; topics: ForumPublicTopic[]; next: number | null } {
    const sections = (db.prepare(`SELECT ${SECTION_COLUMNS} FROM forum_sections s WHERE s.group_id IS NULL AND s.archived_at IS NULL
        ORDER BY s.position, s.created_at, s.id`).all() as SectionRow[]).map(sectionOut);
    return { sections, ...topicsWhere('1', {}, offset, now) };
}

/** One section and its topics, 30 a page; null for a section nobody on the web may read (a group's, archived, or none). */
export function publicForumSection(id: string, offset = 0, now = Date.now()):
    { section: ForumPublicSection; listed: boolean; topics: ForumPublicTopic[]; next: number | null } | null {
    const row = db.prepare(`SELECT ${SECTION_COLUMNS} FROM forum_sections s WHERE s.id = ? AND s.group_id IS NULL AND s.archived_at IS NULL`).get(id) as SectionRow | undefined;
    if (!row) return null;
    return { section: sectionOut(row), listed: sectionIndexable(row), ...topicsWhere('t.section_id = @section', { section: id }, offset, now) };
}

/** A topic and its public posts in order, 30 after post number `after`; null for a topic nobody on the web may read. */
export function publicForumTopic(id: string, after = 0, now = Date.now()):
    { section: ForumPublicSection; topic: ForumPublicTopic; posts: ForumPublicPost[]; next: number | null } | null {
    const t = db.prepare(`SELECT ${TOPIC_COLUMNS} FROM forum_topics t JOIN forum_sections s ON s.id = t.section_id WHERE t.id = ? AND ${PUBLIC_TOPIC('t')}`)
        .get(id) as TopicRow | undefined;
    if (!t) return null;
    const section = db.prepare(`SELECT ${SECTION_COLUMNS} FROM forum_sections s WHERE s.id = ?`).get(t.section_id) as SectionRow;
    const rows = db.prepare(`SELECT p.id, p.topic_id, p.number, p.writer_pubkey, p.words, p.created_at, p.edited_at, p.lang,
            CASE WHEN EXISTS (SELECT 1 FROM forum_posts q WHERE q.topic_id = p.topic_id AND q.number = p.quotes AND ${PUBLIC_POST('q')}) THEN p.quotes END AS public_quotes,
            (SELECT COUNT(*) FROM forum_post_photos f WHERE f.post_id = p.id) AS photo_count
        FROM forum_posts p WHERE p.topic_id = ? AND p.number > ? AND ${PUBLIC_POST('p')} ORDER BY p.number LIMIT ?`)
        .all(id, after, FORUM_LIMITS.postsPerPage + 1) as PostRow[];
    const page = rows.slice(0, FORUM_LIMITS.postsPerPage);
    const writer = writersOf([t.writer_pubkey, ...page.map((p) => p.writer_pubkey)]);
    return {
        section: sectionOut(section),
        topic: topicOut(t, writer, now),
        posts: page.map((p) => ({
            id: p.id, topicId: p.topic_id, number: p.number, writer: writer(p.writer_pubkey), words: p.words, quotes: p.public_quotes,
            createdAt: p.created_at, edited: p.edited_at !== null, photos: p.photo_count, lang: p.lang,
        })),
        next: rows.length > FORUM_LIMITS.postsPerPage ? page[page.length - 1].number : null,
    };
}

/** One photo of a public post in a public topic, as its data URL; null for anything else. */
export function publicForumPhoto(postId: string, n: number): string | null {
    const row = db.prepare(`SELECT f.photo_data FROM forum_post_photos f JOIN forum_posts p ON p.id = f.post_id JOIN forum_topics t ON t.id = p.topic_id
        WHERE f.post_id = ? AND f.order_num = ? AND ${PUBLIC_POST('p')} AND ${PUBLIC_TOPIC('t')}`).get(postId, n) as { photo_data: string } | undefined;
    return row?.photo_data ?? null;
}

/** What the sitemap lists: every listed, open section, and every topic search engines may list now, newest first. */
export function publicForumSitemap(now = Date.now()): { sections: { id: string }[]; topics: { id: string; lastActivityAt: string }[] } {
    const sections = db.prepare(`SELECT s.id FROM forum_sections s WHERE s.group_id IS NULL AND s.archived_at IS NULL AND ${SECTION_MAY_BE_LISTED('s')}
        ORDER BY s.position, s.created_at, s.id`).all() as { id: string }[];
    const since = iso(now - FORUM_TIMES.indexAfterDays * DAY_MS);
    const topics = db.prepare(`SELECT t.id, t.last_activity_at AS lastActivityAt FROM forum_topics t JOIN forum_sections s ON s.id = t.section_id
        WHERE ${LISTED_TOPIC('t')} AND ${SECTION_MAY_BE_LISTED('s')} AND t.never_listed = 0
          AND (SELECT o.public_from FROM forum_posts o WHERE o.topic_id = t.id AND o.number = 1) <= ?
        ORDER BY t.last_activity_at DESC, t.id ASC LIMIT 45000`).all(since) as { id: string; lastActivityAt: string }[];
    return { sections, topics };
}
