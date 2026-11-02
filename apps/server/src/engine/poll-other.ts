// A poll's typed Other: the one way its words leave the node. No read of a post carries them (getPosts counts them, no
// more), so push, Pulse, the directory, the listings pull, a guest, a socket and the search index have nothing to send.
//
// Who: the poll's maker and the owners, on every path (Marty's board answer, 2 Nov). Not an admin, a member or a guest.
//
// When, on an anonymous poll: only once it has closed. A maker who could read each line as it landed could match it to who
// was seen answering at that moment; the same rule as where votes came from (@beanpool/engine pollOriginsMayShow, #1458). The
// lines come in the order of their random ids, with no time: arrival order isn't kept to give. An open vote names its voters
// anyway, so its words read at once.
//
// A report of a line names the poll and the line, never a person: nothing knows who wrote it on an anonymous poll, and an
// open vote's report goes the same way, so the queue reads alike. Its row holds no words, because an admin reads that queue.
//
// A poll taken off takes its words, however it went: pollWordsGoWithThePoll, one trigger, so no path can leave them behind.

import crypto from 'node:crypto';
import { getPosts, readsAsMember, type MarketplacePost } from '@beanpool/engine';
import { pollOtherOption, wordsFor, word } from '@beanpool/core';
import { db } from '../db/db.js';
import { truncateWalAfterDelete } from '../db/wal-truncate.js';
import { getNodeRole } from '../config/node-role.js';
import { bumpPostsVersion } from './versions.js';
import { isNodeOwner } from './node-roles.js';
import { marketplacePostOutOfSight } from './post-sight.js';

const { t: tr } = wordsFor('en');

/** abuse_reports.disclosure's kind on a report of a typed answer: JSON { kind, postId, answerId }. */
export const POLL_ANSWER_DISCLOSURE_KIND = 'poll-answer';

/** Who a report of a typed answer is about: nobody. No action on the report can reach a member (state-engine reportSubjectOf). */
export const POLL_ANSWER_REPORT_SUBJECT = 'SYSTEM';

/** Refused with an HTTP status and words: `status` is what the route answers. */
export class PollOtherError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
        this.name = 'PollOtherError';
    }
}

export interface PollOtherRead {
    /** `held`: an anonymous poll still open, so no words yet. `open`: the words are here. */
    state: 'held' | 'open';
    /** How many chose Other: what everyone sees on the card. */
    count: number;
    /** The lines left to read, in the order of their random ids. `reported`: a report of it is waiting for an owner. */
    answers: Array<{ id: string; words: string; reported: boolean }>;
    /** How many an owner has removed. */
    removed: number;
    /** Whether this reader may remove a line (an owner). */
    canRemove: boolean;
}

/** The poll, for someone who may read its words; else refused, as an id nobody has where they can't see it. */
function pollForWords(postId: string, reader: string): MarketplacePost {
    const post = getPosts(db, { id: postId, includeAllScopes: true, viewerPubkey: reader })[0];
    if (!post || post.type !== 'poll' || marketplacePostOutOfSight(post, reader) || !pollOtherOption(post.pollOptions)) {
        throw new PollOtherError(404, word('Poll not found'));
    }
    // A pruned account's or an old key's row still says it made the poll: only someone who reads as a member here reads on.
    if (!readsAsMember(db, reader) || (post.authorPublicKey !== reader && !isNodeOwner(reader))) {
        throw new PollOtherError(403, word("Typed answers are for the poll's maker and the owners"));
    }
    return post;
}

function holdsWords(post: MarketplacePost): boolean {
    if (post.pollOpenVote === true) return false;
    return post.status !== 'completed' && !(post.pollClosesAt && post.pollClosesAt <= new Date().toISOString());
}

function reportedAnswers(postId: string): Set<string> {
    const rows = db.prepare(`SELECT json_extract(disclosure, '$.answerId') AS answer FROM abuse_reports
        WHERE json_valid(disclosure) AND json_extract(disclosure, '$.kind') = ? AND json_extract(disclosure, '$.postId') = ?
          AND (status = 'pending' OR status IS NULL)`).all(POLL_ANSWER_DISCLOSURE_KIND, postId) as { answer: string }[];
    return new Set(rows.map((r) => r.answer));
}

/** A poll's typed answers for its maker or an owner: GET /api/marketplace/posts/:id/other-answers, and the assistant's poll_results. */
export function readPollOtherAnswers(postId: string, reader: string): PollOtherRead {
    const post = pollForWords(postId, reader);
    const count = pollOtherOption(post.pollOptions)?.votes ?? 0;
    const canRemove = isNodeOwner(reader);
    if (holdsWords(post)) return { state: 'held', count, answers: [], removed: 0, canRemove };
    const rows = db.prepare(`SELECT id, words, words_removed FROM poll_answers WHERE post_id = ? AND (words IS NOT NULL OR words_removed = 1) ORDER BY id`)
        .all(postId) as { id: string; words: string | null; words_removed: number }[];
    const reported = reportedAnswers(postId);
    return {
        state: 'open', count, canRemove,
        answers: rows.filter((r) => r.words !== null).map((r) => ({ id: r.id, words: r.words as string, reported: reported.has(r.id) })),
        removed: rows.filter((r) => r.words_removed === 1).length,
    };
}

function lineOf(postId: string, answerId: string): { words: string | null } {
    const line = db.prepare('SELECT words FROM poll_answers WHERE post_id = ? AND id = ?').get(postId, answerId) as { words: string | null } | undefined;
    if (!line || line.words === null) throw new PollOtherError(404, word('That typed answer is not here'));
    return line;
}

/** An owner takes a line down: the words go for good, here and at the next copy; the vote still counts. */
export function removePollOtherAnswer(postId: string, answerId: string, actor: string): void {
    pollForWords(postId, actor);
    if (!isNodeOwner(actor)) throw new PollOtherError(403, word('Only an owner can remove a typed answer'));
    lineOf(postId, answerId);
    const nowIso = new Date().toISOString();
    db.transaction(() => {
        db.prepare('UPDATE poll_answers SET words = NULL, words_removed = 1 WHERE post_id = ? AND id = ?').run(postId, answerId);
        // A standby finds it by the poll (replication-manifest poll_answers), and a read's cached copy goes with this.
        db.prepare('UPDATE posts SET updated_at = ? WHERE id = ?').run(nowIso, postId);
        closeLineReports(postId, answerId);
    })();
    bumpPostsVersion();
    truncateWalAfterDelete('a typed answer was removed');
}

/** What waits on a poll's lines, done with, as SQL: `post` and `answer` are SQL too, and an answer of NULL means every line's. */
const closeReportsSql = (post: string, answer: string) => `UPDATE abuse_reports SET status = 'actioned', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE json_valid(disclosure) AND json_extract(disclosure, '$.kind') = '${POLL_ANSWER_DISCLOSURE_KIND}' AND json_extract(disclosure, '$.postId') = ${post}
      AND (${answer} IS NULL OR json_extract(disclosure, '$.answerId') = ${answer}) AND (status = 'pending' OR status IS NULL)`;

function closeLineReports(postId: string, answerId: string): void {
    db.prepare(closeReportsSql('@postId', '@answerId')).run({ postId, answerId });
}

/**
 * An open vote changed: the voter's line goes with the answer it was, and a report of it waits for nobody. In the caller's
 * transaction, which has moved the poll, so a standby hears.
 */
export function takeBackPollLine(postId: string, answerId: string): void {
    db.prepare('DELETE FROM poll_answers WHERE post_id = ? AND id = ?').run(postId, answerId);
    closeLineReports(postId, answerId);
    truncateWalAfterDelete('a typed answer was taken back');
}

/**
 * The one place a poll's words go with the poll. Run once at boot, outside any transaction, on the connection that writes.
 *
 * A poll goes off every reader's screen when `active` falls to 0, and many paths do that: its maker's removal, a moderator's, a
 * convenor's, a group's close, its maker leaving (their own deletion, or an admin's or the community's removal). Each has its
 * own SQL, one is in @beanpool/engine, which can't import this file, and past 0 no read finds the poll, so not even an owner can
 * read or remove a line. Nothing hard-deletes a poll and foreign keys are off (db/db.ts), so without this the words would stay
 * in the table and on every standby, for nobody to read (Marty, 2 Nov: a removed poll takes its typed answers). So the rule sits
 * on the row, not on the paths: a path written later can't forget it.
 *
 * In the transaction that took the poll off: its words go, its rows stay, as its ballots and its counts do, and a report of any
 * line closes. Each path has moved the poll (posts_touch_updated_at moves it for one that didn't), so a standby hears, and the
 * WAL is emptied once it has committed. A closing keeps `active` at 1: the words are what it opens, and nothing here runs.
 *
 * Main server only: a standby takes the poll's lines from the copy, which names them all (engine/sync.ts replacePollAnswers), and
 * its reports with them, so the two end up the same. TEMP, like the other triggers that call a connection function: nothing lands
 * in the file, so an older image boots on it, and no copy carries it.
 */
export function pollWordsGoWithThePoll(): void {
    db.function('poll_words_go_here', { deterministic: false }, () => (getNodeRole() === 'primary' ? 1 : 0));
    db.function('poll_words_went', { deterministic: false }, () => {
        const emptyTheWal = () => truncateWalAfterDelete('a poll went, with its typed answers');
        // A statement on its own has no transaction to wait for, and a connection can't checkpoint inside its own statement.
        if (db.inTransaction) emptyTheWal(); else setImmediate(emptyTheWal);
        return null;
    });
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS poll_off_takes_its_words AFTER UPDATE OF active ON main.posts
        WHEN NEW.active = 0 AND NEW.type = 'poll' AND poll_words_go_here() = 1
        BEGIN
            SELECT poll_words_went() WHERE EXISTS (SELECT 1 FROM poll_answers WHERE post_id = NEW.id AND words IS NOT NULL);
            UPDATE poll_answers SET words = NULL, words_removed = 1 WHERE post_id = NEW.id AND words IS NOT NULL;
            ${closeReportsSql('NEW.id', 'NULL')};
        END`);
}

/**
 * A deleted account's lines, where a row says which they are: an open vote names its voter, so it leads to their words, and
 * those go as every line they wrote does (engine/message-tombstone.ts). A sealed answer can't be found, which the guide tells
 * them. The vote still counts. In the caller's transaction, stamped `at` so a standby hears.
 */
export function dropOpenVoteWordsOf(publicKey: string, at: string): void {
    const lines = db.prepare('SELECT post_id, other_answer_id FROM poll_votes WHERE voter_pubkey = ? AND other_answer_id IS NOT NULL')
        .all(publicKey) as { post_id: string; other_answer_id: string }[];
    const blank = db.prepare('UPDATE poll_answers SET words = NULL, words_removed = 1 WHERE post_id = ? AND id = ? AND words IS NOT NULL');
    const move = db.prepare('UPDATE posts SET updated_at = ? WHERE id = ?');
    for (const line of lines) {
        blank.run(line.post_id, line.other_answer_id);
        move.run(at, line.post_id);
        closeLineReports(line.post_id, line.other_answer_id);
    }
}

/**
 * A report of one line, for the owners: only someone who can read the line can file it. Once per reporter per line. The row
 * names no person and holds no words (this file's header). Answers the report's id; `duplicate` when it was already filed.
 */
export function reportPollOtherAnswer(postId: string, answerId: string, reporter: string): { id: string; duplicate: boolean } {
    const post = pollForWords(postId, reporter);
    if (holdsWords(post)) throw new PollOtherError(404, word('That typed answer is not here'));
    lineOf(postId, answerId);
    const disclosure = JSON.stringify({ kind: POLL_ANSWER_DISCLOSURE_KIND, postId, answerId });
    const filed = db.prepare(`SELECT id FROM abuse_reports WHERE reporter_pubkey = ? AND disclosure = ? AND (status = 'pending' OR status IS NULL)`)
        .get(reporter, disclosure) as { id: string } | undefined;
    if (filed) return { id: filed.id, duplicate: true };
    const id = crypto.randomUUID();
    // In the node's English, as a reason a moderator reads (state-engine reportPauseReason): the question is the public card's.
    const reason = tr('A typed answer on the poll "{question}" was reported. An owner can read and remove it on the poll\'s card.', { question: post.title }).slice(0, 500);
    db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, disclosure, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, reporter, POLL_ANSWER_REPORT_SUBJECT, disclosure, reason, new Date().toISOString());
    return { id, duplicate: false };
}
