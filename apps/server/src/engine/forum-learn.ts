/**
 * "Turn into a Learn page" (forum slice F9; scratch/fable-design/DESIGN-forums-fable.md §10.3, through Learn's own doors,
 * DESIGN-local-knowledge-fable.md §2.4 and §5). On a community where Learn is on:
 *
 * - **Only the answer's writer turns it.** A member sends it to Learn's waiting list (POST /api/knowledge/drafts with
 *   `fromForumPostId`: engine/knowledge-drafts.ts suggestKnowledge records the answer in `from_forum_post_id`); an owner's or
 *   admin's own goes up at once (POST /api/knowledge/posts with `fromForumPostId`: publishFromAnswer). The words are whatever
 *   their form sends (the apps fill it with the topic's title and the answer's words): the forum moves nothing by itself.
 * - **An owner or admin asks.** "Ask {name} to make this a Learn page" (askForLearnPage) tells the writer with one bell row
 *   (engine/forum-notices.ts tellForumLearnAsk, under the bell's rules), never a draft: their words are not republished
 *   without their own tap.
 * - **Which answers.** A reply (an opening post is the question), live: not removed, not hidden while moderators look, in a
 *   topic the reader may read, and not in a group's section (a group's words are for its members; Learn has no group-only
 *   page). Not one already waiting, nor one already a page that shows.
 * - **The link comes with the page.** Learn's own approval (or the owner's or admin's own publish) makes the page, and only
 *   then is the answer linked to it (linkLearnPage: forum_links kind 'learn', `post_id` the answer), if the answer is still
 *   live then; else the page is made and nothing is linked. The answer then reads "Now a Learn page" to whoever may see the
 *   page (engine/forum.ts postsOut, through forum-links' reader rule), and the page's "From the forum" names the topic
 *   (forumTopicsLinking). Such a link is the answer's, never a chip of the topic's writer, and never counts in their three.
 *
 * Every write refuses on a standby; none is a ledger write. No log line holds an answer's words.
 */
import { word } from '@beanpool/core';
import type { MarketplacePost } from '@beanpool/engine';
import { db } from '../db/db.js';
import { assertFeatureOn, getProfileSwitches } from '../config/node-profile.js';
import { assertPlainTablesWritable } from '../config/node-role.js';
import { assertNotMuted } from './auto-moderation.js';
import { FORUM_WORDS, ForumRefusal, readableForumTopic } from './forum.js';
import { tellForumLearnAsk, type ForumNoticeCallbacks } from './forum-notices.js';
import { KNOWLEDGE_WORDS, KnowledgeRefusal, checksKnowledge, publishKnowledge, showingKnowledgeRow, type KnowledgeInput } from './knowledge.js';

type BroadcastFn = (event: any, recipients?: string[], opts?: { listingParties?: string[] }) => void;
const iso = (ms: number) => new Date(ms).toISOString();

export const FORUM_LEARN_WORDS = {
    notYours: word('Only its writer can turn an answer into a Learn page.'),
    notAnAnswer: word('Only an answer can become a Learn page, not the question that opens a topic.'),
    hidden: word('This answer is hidden while moderators look, so it can’t become a Learn page now.'),
    groupSection: word('An answer in a group’s section stays with the group, so it can’t become a Learn page.'),
    waiting: word('This answer is already waiting to become a Learn page.'),
    already: word('This answer is already a Learn page.'),
    ownAnswer: word('This is your own answer: turn it into a Learn page yourself.'),
    adminsOnly: word('Only an owner or admin can ask for this.'),
    learnOff: word('Learn is switched off in this community, so an answer can’t become a Learn page.'),
    fixFromForum: word('A fix changes a page that is there: it doesn’t come from a forum answer.'),
};

interface AnswerRow { id: string; topic_id: string; number: number; writer_pubkey: string; removed_by: string | null; hidden_by_reports_at: string | null }
export interface TurnableAnswer { id: string; topicId: string; number: number; writer: string }

/** The page made from this answer that still shows, if any. */
function pageOfAnswer(postId: string): string | null {
    const targets = db.prepare("SELECT target_id FROM forum_links WHERE kind = 'learn' AND post_id = ?").pluck().all(postId) as string[];
    return targets.find((id) => !!showingKnowledgeRow(id)) ?? null;
}

/**
 * The answer `postId` as `reader` may turn it (`as` 'writer': their own) or ask its writer to turn (`as` 'asker': someone
 * else's), or the refusal, in this order: one they may not see (removed, by someone they blocked, in a topic they may not
 * read) as an id nobody has, 404; an opening post, 400; not theirs (or, asking, their own); hidden while moderators look;
 * in a group's section; already waiting; already a page that shows.
 */
export function turnableAnswer(reader: string, postId: unknown, as: 'writer' | 'asker'): TurnableAnswer {
    const p = typeof postId === 'string' && postId.length > 0 && postId.length <= 64
        ? db.prepare('SELECT id, topic_id, number, writer_pubkey, removed_by, hidden_by_reports_at FROM forum_posts WHERE id = ?').get(postId) as AnswerRow | undefined
        : undefined;
    if (!p || p.removed_by || db.prepare('SELECT 1 FROM member_blocks WHERE owner_pubkey = ? AND blocked_pubkey = ?').get(reader, p.writer_pubkey)) {
        throw new ForumRefusal(404, 'not_found', FORUM_WORDS.postNotFound);
    }
    const topic = readableForumTopic(reader, p.topic_id);
    if (p.number <= 1) throw new ForumRefusal(400, 'not_an_answer', FORUM_LEARN_WORDS.notAnAnswer);
    if (as === 'writer' && p.writer_pubkey !== reader) throw new ForumRefusal(403, 'not_your_answer', FORUM_LEARN_WORDS.notYours);
    if (as === 'asker' && p.writer_pubkey === reader) throw new ForumRefusal(409, 'own_answer', FORUM_LEARN_WORDS.ownAnswer);
    if (p.hidden_by_reports_at) throw new ForumRefusal(409, 'answer_hidden', FORUM_LEARN_WORDS.hidden);
    if (db.prepare('SELECT group_id FROM forum_sections WHERE id = ?').pluck().get(topic.section_id)) {
        throw new ForumRefusal(403, 'group_section', FORUM_LEARN_WORDS.groupSection);
    }
    if (db.prepare("SELECT 1 FROM knowledge_drafts WHERE from_forum_post_id = ? AND state = 'waiting'").get(p.id)) {
        throw new ForumRefusal(409, 'learn_waiting', FORUM_LEARN_WORDS.waiting);
    }
    if (pageOfAnswer(p.id)) throw new ForumRefusal(409, 'already_learn', FORUM_LEARN_WORDS.already);
    return { id: p.id, topicId: p.topic_id, number: p.number, writer: p.writer_pubkey };
}

/**
 * Links the page just made to the answer it came from, when the answer is still `writer`'s, live (not removed, not hidden),
 * a reply, in a topic that is there and not in a group's section. Returns whether it linked. Inside the caller's
 * transaction, right after the page is made.
 */
export function linkLearnPage(postId: string, pageId: string, writer: string, now: number): boolean {
    const p = db.prepare(`SELECT fp.topic_id, fp.number, fp.writer_pubkey, fp.removed_by, fp.hidden_by_reports_at, t.closed_by, s.group_id
        FROM forum_posts fp JOIN forum_topics t ON t.id = fp.topic_id JOIN forum_sections s ON s.id = t.section_id WHERE fp.id = ?`).get(postId) as
        { topic_id: string; number: number; writer_pubkey: string; removed_by: string | null; hidden_by_reports_at: string | null; closed_by: string | null; group_id: string | null } | undefined;
    if (!p || p.writer_pubkey !== writer || p.number <= 1 || p.removed_by || p.hidden_by_reports_at || p.closed_by === 'removed' || p.group_id) return false;
    return db.prepare("INSERT OR IGNORE INTO forum_links (topic_id, kind, target_id, created_at, post_id) VALUES (?, 'learn', ?, ?, ?)")
        .run(p.topic_id, pageId, iso(now), postId).changes === 1;
}

/**
 * An owner's or admin's own answer, published at once (POST /api/knowledge/posts with `fromForumPostId`): Learn's own
 * publishKnowledge makes the page with the words sent, and the answer is linked to it, in one transaction.
 */
export function publishFromAnswer(broadcast: BroadcastFn, member: string, raw: KnowledgeInput & { photos?: unknown; fromForumPostId?: unknown }, now = Date.now()): MarketplacePost {
    assertPlainTablesWritable();
    assertFeatureOn('knowledge');
    if (!checksKnowledge(member)) throw new KnowledgeRefusal(403, 'admins_only', KNOWLEDGE_WORDS.adminsOnly);
    return db.transaction(() => {
        const answer = turnableAnswer(member, raw.fromForumPostId, 'writer');
        const post = publishKnowledge(broadcast, member, raw, { now });
        linkLearnPage(answer.id, post.id, member, now);
        return post;
    })();
}

/**
 * "Ask {name} to make this a Learn page" (§10.3): an owner or admin, of someone else's answer that could be turned now. The
 * writer gets one bell row (engine/forum-notices.ts tellForumLearnAsk, under the bell's rules); the asker reads `asked`
 * whether or not a row went, so nothing about the writer's switches or blocks reaches them. Nothing is drafted.
 */
export function askForLearnPage(cb: ForumNoticeCallbacks, asker: string, postId: unknown, now = Date.now()): { asked: true } {
    assertPlainTablesWritable();
    assertNotMuted(asker, now);
    if (!getProfileSwitches().knowledge) throw new ForumRefusal(404, 'learn_off', FORUM_LEARN_WORDS.learnOff);
    if (!checksKnowledge(asker)) throw new ForumRefusal(403, 'admins_only', FORUM_LEARN_WORDS.adminsOnly);
    const answer = turnableAnswer(asker, postId, 'asker');
    tellForumLearnAsk(cb, { topicId: answer.topicId, postId: answer.id, number: answer.number, writer: answer.writer, asker }, now);
    return { asked: true };
}
