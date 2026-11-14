/**
 * The forum's search (scratch/fable-design/DESIGN-forums-fable.md §8, §16; slice F6): one box, for members, over titles,
 * opening posts and replies, newest first, each hit opening at its post. routes/forum.ts answers it (GET /api/forum/search).
 *
 * - **The index** is `forum_search` (db/schema.sql): one row per post, its words, and on an opening post its topic's title and
 *   place. Kept by triggers on forum_posts and forum_topics, on every server that holds them, so a standby's import keeps its
 *   own and answers the same. A waiting first topic is never a post, so it is never in the index or an answer.
 * - **What a member types.** Every word must be found (in the post's words, or its topic's title or place when it is the
 *   opening post), each as the start of a word, as the Market's search reads a word (apostrophes folded, an elided word
 *   asked on its own too). At most {@link FORUM_SEARCH_WORDS_MAX} words count.
 * - **Scripts written without spaces** (Thai, Lao, Myanmar, Khmer, Japanese, Chinese) are one token to the index, so a word
 *   inside a run is also looked for anywhere in the text, as the Market's fallback does (engine posts.ts searchCondition), but
 *   only among the newest {@link FORUM_SEARCH_SCAN_MAX} posts, so one search never reads the whole table.
 * - **What is never an answer** ({@link SEARCHABLE}, the one rule every hit passes): a removed post, a hidden one (for anyone,
 *   its writer and the moderators included), any post of a topic that is gone or whose opening post is hidden, anything in an
 *   archived section (out of every list), anything by someone the reader blocked or in a topic they started. A section only
 *   some members may read (a group's, slice F8) adds its test to {@link SEARCHABLE_SECTION}, and every search has it.
 * - **The day's searches.** 100 in any 24 hours a member (@beanpool/core FORUM_SEARCHES_PER_DAY, the number people-search
 *   uses), counted in memory per key as people-search counts its own (nearest-people-budget.ts dayBudget): a restart starts
 *   them again. A search refused before it runs (no words, too long) is not counted.
 *
 * No log line holds what was searched.
 */
import { FORUM_SEARCHES_PER_DAY, elidedWord, foldApostrophes, word, wordsFor } from '@beanpool/core';
import { getMember } from '@beanpool/engine';
import { db } from '../db/db.js';
import { dayBudget } from '../nearest-people-budget.js';
import { ForumRefusal, ensureForumStarters, type ForumWriter } from './forum.js';

const { t: tr } = wordsFor('en');

/** Characters a search may hold: a few words, never a page of them. */
export const FORUM_SEARCH_CHARS_MAX = 200;
/** Typed words a search asks for; the rest are left out (8: as many as the Market lets scan without spaces). */
export const FORUM_SEARCH_WORDS_MAX = 8;
/** The newest posts a word of a script without spaces is looked for inside (design §8). */
export const FORUM_SEARCH_SCAN_MAX = 20_000;
/** Hits in one answer; `offset` pages on, at most {@link FORUM_SEARCH_OFFSET_MAX}. */
export const FORUM_SEARCH_PAGE = 20;
export const FORUM_SEARCH_OFFSET_MAX = 1_000;
/** Characters of a post's words a hit carries, around the first word found. */
export const FORUM_SEARCH_EXCERPT = 160;

export const FORUM_SEARCH_WORDS = {
    noWords: word('Type a word to search for.'),
};

/**
 * Letters of the scripts written without spaces, as the engine's UNSPACED_SCRIPT (posts.ts) and core's tag search read them:
 * Thai, Lao, Myanmar, Khmer, the kana, and the Han characters (with the supplementary planes' as surrogate pairs).
 */
const UNSPACED_SCRIPT = /[฀-໿က-႟ក-៿぀-ヿㇰ-ㇿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]|[\ud840-\ud87f][\udc00-\udfff]/;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const APOSTROPHES_AROUND = /^['’ʼ]+|['’ʼ]+$/g;
/** A word with no letter or digit holds nothing the index keeps ("-", "…", an emoji): it asks for nothing. */
const HAS_LETTER = /[\p{L}\p{N}]/u;

/** One typed word: any of `asks` may match it; `inside`, for a word of a script without spaces, is also looked for anywhere. */
export interface ForumSearchWord { asks: string[]; inside: string | null }

/** The words a search asks for, each typed word once, at most FORUM_SEARCH_WORDS_MAX. */
export function forumSearchWords(query: string): ForumSearchWord[] {
    const out: ForumSearchWord[] = [];
    const seen = new Set<string>();
    for (const typed of query.replace(CONTROL_CHARACTERS, ' ').replace(/"/g, '').split(/\s+/)) {
        const plain = foldApostrophes(typed).replace(APOSTROPHES_AROUND, '');
        if (!plain || !HAS_LETTER.test(plain) || seen.has(plain.toLowerCase())) continue;
        seen.add(plain.toLowerCase());
        const asks = new Set([plain]);
        // unicode61 reads U+02BC as a letter: a post typed with it holds the word whole, so it is asked as typed too.
        if (typed.includes('ʼ')) asks.add(typed.replace(APOSTROPHES_AROUND, ''));
        const elided = elidedWord(plain);
        if (elided) asks.add(elided);
        out.push({ asks: [...asks], inside: UNSPACED_SCRIPT.test(plain) ? plain : null });
        if (out.length === FORUM_SEARCH_WORDS_MAX) break;
    }
    return out;
}

const matchOf = (w: ForumSearchWord) => `(${w.asks.map((a) => `"${a}"*`).join(' OR ')})`;
const likeOf = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * The sections a member's search reads: those out of no list. The one place a section's own rule goes (a group's section,
 * slice F8: its members and the moderators only), so no search can miss it.
 */
export const SEARCHABLE_SECTION = 't.section_id IN (SELECT id FROM forum_sections WHERE archived_at IS NULL)';

/**
 * The one rule every hit passes, on post `p` in topic `t`, for the reader (@reader). Stricter than a topic's read: a hidden
 * post is never a hit, even for its writer or a moderator, who read it in its topic.
 */
export const SEARCHABLE = [
    'p.removed_by IS NULL',
    'p.hidden_by_reports_at IS NULL',
    "COALESCE(t.closed_by, '') != 'removed'",
    'NOT EXISTS (SELECT 1 FROM forum_posts h WHERE h.topic_id = t.id AND h.number = 1 AND (h.hidden_by_reports_at IS NOT NULL))',
    SEARCHABLE_SECTION,
    'p.writer_pubkey NOT IN (SELECT blocked_pubkey FROM member_blocks WHERE owner_pubkey = @reader)',
    't.writer_pubkey NOT IN (SELECT blocked_pubkey FROM member_blocks WHERE owner_pubkey = @reader)',
].join(' AND ');

/** A search's hit: the post, its topic's title (empty for a topic its writer removed, its replies kept), and its words around the find. */
export interface ForumSearchHit {
    topicId: string; sectionId: string; title: string;
    postId: string; number: number; writer: ForumWriter; createdAt: string;
    /** Up to FORUM_SEARCH_EXCERPT characters of its words, around the first word found; '…' where cut. */
    excerpt: string;
}

/** Up to FORUM_SEARCH_EXCERPT characters of `words` around the first of `words` asked, whitespace made single spaces. */
export function forumExcerpt(text: string, asked: ForumSearchWord[]): string {
    const chars = Array.from(text.replace(/\s+/g, ' ').trim());
    if (chars.length <= FORUM_SEARCH_EXCERPT) return chars.join('');
    const folded = foldApostrophes(chars.join('')).toLowerCase();
    let at = -1;
    for (const w of asked) {
        for (const a of w.asks) {
            const i = folded.indexOf(a.toLowerCase());
            if (i >= 0 && (at < 0 || i < at)) at = i;
        }
    }
    // A UTF-16 index into the folded, lower-cased text, as a count of characters: near enough to place the window (lower
    // case lengthens a rare letter, İ), and the window is held inside the words either way.
    const atChar = at < 0 ? 0 : Array.from(folded.slice(0, at)).length;
    const start = Math.max(0, Math.min(atChar - 40, chars.length - FORUM_SEARCH_EXCERPT));
    const end = Math.min(chars.length, start + FORUM_SEARCH_EXCERPT);
    return `${start > 0 ? '…' : ''}${chars.slice(start, end).join('').trim()}${end < chars.length ? '…' : ''}`;
}

/**
 * The statement a search runs and its parameters: the words asked, then SEARCHABLE, newest first, a page from `offset`.
 * Exported for the test that reads its plan (no search walks forum_posts whole).
 */
export function forumSearchQuery(asked: ForumSearchWord[], at: { reader: string; offset: number }): { sql: string; params: Record<string, unknown> } {
    const params: Record<string, unknown> = { reader: at.reader, limit: FORUM_SEARCH_PAGE + 1, offset: at.offset };
    const where: string[] = [];
    // Words of spaced scripts: one look in the index, every word in the same post.
    const spaced = asked.filter((w) => w.inside === null);
    if (spaced.length > 0) {
        where.push('p.rowid IN (SELECT rowid FROM forum_search WHERE forum_search MATCH @match)');
        params.match = spaced.map(matchOf).join(' AND ');
    }
    // Words of scripts without spaces: the index, or anywhere in the text among the newest posts.
    const unspaced = asked.filter((w) => w.inside !== null);
    if (unspaced.length > 0) {
        params.since = (db.prepare('SELECT created_at FROM forum_posts ORDER BY created_at DESC LIMIT 1 OFFSET ?').pluck()
            .get(FORUM_SEARCH_SCAN_MAX - 1) as string | undefined) ?? '';
        unspaced.forEach((w, i) => {
            params[`m${i}`] = matchOf(w);
            params[`l${i}`] = likeOf(w.inside!);
            // Two sets of posts by rowid, so no search walks the table: the index's, and the newest posts' own scan (a range of
            // idx_forum_posts_created, FORUM_SEARCH_SCAN_MAX rows at most).
            where.push(`(p.rowid IN (SELECT rowid FROM forum_search WHERE forum_search MATCH @m${i})
                OR p.rowid IN (SELECT n.rowid FROM forum_posts n JOIN forum_topics nt ON nt.id = n.topic_id WHERE n.created_at >= @since
                    AND (n.words LIKE @l${i} ESCAPE '\\' OR (n.number = 1 AND (nt.title LIKE @l${i} ESCAPE '\\' OR COALESCE(nt.place, '') LIKE @l${i} ESCAPE '\\')))))`);
        });
    }
    const sql = `
        SELECT p.id, p.number, p.writer_pubkey, p.words, p.created_at, t.id AS topic_id, t.section_id, t.title
          FROM forum_posts p JOIN forum_topics t ON t.id = p.topic_id
         WHERE ${where.join(' AND ')} AND ${SEARCHABLE}
         ORDER BY p.created_at DESC, p.id DESC LIMIT @limit OFFSET @offset`;
    return { sql, params };
}

const searches = dayBudget(() => FORUM_SEARCHES_PER_DAY, (limit) => ({
    error: tr('You can search the forum {n} times in any 24 hours. Try again later.', { n: limit }),
    code: 'searches_per_day',
}));

/** A search refused for the day: its seconds until the oldest search counted leaves the day. */
export class ForumSearchRefusal extends ForumRefusal {
    constructor(message: string, readonly retryAfterSec: number) {
        super(429, 'searches_per_day', message);
    }
}

/** Forget every member's count of the day's searches (tests). */
export function resetForumSearchBudget(): void {
    searches.reset();
}

/**
 * A member's search, newest first, FORUM_SEARCH_PAGE hits from `offset`. Refused with no word to look for (400), past
 * FORUM_SEARCH_CHARS_MAX characters (400), or past the day's searches (429, uncounted).
 */
export function searchForum(reader: string, query: unknown, offset: number, now = Date.now()): { hits: ForumSearchHit[]; next: number | null } {
    if (typeof query !== 'string') throw new ForumRefusal(400, 'bad_request', FORUM_SEARCH_WORDS.noWords);
    if (Array.from(query.trim()).length > FORUM_SEARCH_CHARS_MAX) throw new ForumRefusal(400, 'too_long', tr('At most {n} characters.', { n: FORUM_SEARCH_CHARS_MAX }));
    const asked = forumSearchWords(query);
    if (asked.length === 0) throw new ForumRefusal(400, 'no_words', FORUM_SEARCH_WORDS.noWords);
    const spent = searches.charge(reader, now);
    if (spent) throw new ForumSearchRefusal(spent.body.error, spent.retryAfterSec);
    ensureForumStarters(now);

    const { sql, params } = forumSearchQuery(asked, { reader, offset });
    const rows = db.prepare(sql).all(params) as
        { id: string; number: number; writer_pubkey: string; words: string; created_at: string; topic_id: string; section_id: string; title: string }[];
    const more = rows.length > FORUM_SEARCH_PAGE;
    const names = new Map<string, string>();
    const nameOf = (pk: string) => {
        if (!names.has(pk)) names.set(pk, getMember(db, pk)?.callsign ?? '');
        return names.get(pk)!;
    };
    return {
        hits: rows.slice(0, FORUM_SEARCH_PAGE).map((r) => ({
            topicId: r.topic_id, sectionId: r.section_id, title: r.title,
            postId: r.id, number: r.number, writer: { publicKey: r.writer_pubkey, name: nameOf(r.writer_pubkey) }, createdAt: r.created_at,
            excerpt: forumExcerpt(r.words, asked),
        })),
        next: more ? offset + FORUM_SEARCH_PAGE : null,
    };
}
