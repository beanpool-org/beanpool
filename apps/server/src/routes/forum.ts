/**
 * The forum (slice F1; scratch/fable-design/DESIGN-forums-fable.md §2 to §4). engine/forum.ts holds the rules; every route is
 * signed, and the actor is always the signer, never a body field.
 *
 * A member of this community who reads as one (readsAsMember, as the Market's members-only reads): anyone else 403
 * `not_member`, a paused member 403 `not_active` while the pause lasts, unsigned 401:
 *   GET  /api/forum                         → { sections: [section], public, told }   (owners and admins also get archived ones)
 *   GET  /api/forum/topics?section&offset   → { topics: [topic], next }   (pinned first, then the newest activity; 30 a page;
 *        ETag, so an unchanged list answers 304)
 *   GET  /api/forum/topics/:id?after=<n>    → { topic, posts: [post], next }   (30 posts after number n) | 404 `not_found`
 *   GET  /api/forum/posts/:id/photos/:n     → the photo's bytes | 404
 *   GET  /api/forum/search?q&offset         → { hits: [hit], next }   (slice F6, engine/forum-search.ts: every word found, newest
 *        first, 20 a page; never a removed, hidden or waiting post, an archived section's, or a blocked writer's) 400 `no_words`
 *        or `too_long`; 429 `searches_per_day` with Retry-After (100 in any 24 hours). A hit: { topicId, sectionId, title,
 *        postId, number, writer, createdAt, excerpt }
 * An active member, on the main server (a standby 503 `standby`), not muted (403 `moderation_muted`):
 *   POST /api/forum/told                    → { told: true }   (they read that anyone on the web can read this forum)
 *   POST /api/forum/topics                  { sectionId, title, words, place?, lang?, photos? } → 201 { topic, post }
 *        403 `staff_only` (a section only owners and admins start topics in); 409 `tell_first` (a public forum, not told);
 *        429 `topics_per_day`
 *   POST /api/forum/topics/:id/replies      { words, quotes?, lang?, photos? } → 201 { post }   409 `closed`; 429 `replies_per_day`
 *   POST /api/forum/topics/:id/close        → { topic }   (its writer, an owner or an admin) 409 `already_closed`
 *   POST /api/forum/posts/:id/edit          { words, title? } → { topic, post }   (its writer, the topic open, one they may read)
 *   POST /api/forum/posts/:id/remove        → { ok: true }   (its writer)
 * Notices (slice F5, engine/forum-notices.ts): an active member who may read the topic, on the main server:
 *   POST /api/forum/topics/:id/follow       { follow: 'following' | 'muted' | null } → { follow }   (its bell: each reply tells
 *        them, nothing does, or neither; who starts or replies in a topic follows it unless they muted it)
 *   POST /api/forum/topics/:id/read         { upTo } → { lastRead }   (they opened it up to post number upTo: the unread dot
 *        moves, and its bell rows come off the bell). A reply's followers and the people it mentions are told by the bell
 *        and a push; apps that connect with `forum=1` hear `forum_reply` { topicId, number } and `forum_list`.
 * First looks (slice F2, engine/forum-first-look.ts): a new member's topic, where `forumFirstLook` is on, answers 202
 * { waiting } (409 `waiting_already` while one waits; a new member's photos only there, else 403 `new_no_photos`):
 *   GET  /api/forum/first-looks             → { waiting: [waiting] }   oldest first; owners, admins, moderators (else 403 `moderators_only`)
 *   GET  /api/forum/first-looks/mine        → { waiting: waiting | null, usuallyWithinHours }   the signer's own
 *   GET  /api/forum/first-looks/:id/photos/:n → the photo's bytes, to a moderator or its writer | 404
 *   POST /api/forum/first-looks/:id/ok      → { topicId }   a moderator; 409 `section_gone`
 *   POST /api/forum/first-looks/:id/no      { reason } → { ok: true }   a moderator; one of the five removal reasons
 *   POST /api/forum/first-looks/:id/withdraw → { ok: true }   its writer
 * A waiting one: { id, sectionId, title, words, place, lang, photos, writer, createdAt }. Reports of forum posts are POST
 * /api/reports `targetForumPostId`, answered in Settings (routes/admin.ts).
 * An owner or admin; anyone else 403 `staff_only`:
 *   POST /api/forum/topics/:id/pin          { pinned } → { topic }   409 `too_many_pins`
 *   POST /api/forum/topics/:id/move         { sectionId } → { topic }
 *   POST /api/forum/sections                { name, about?, starts?, listed? } → 201 { section }   409 `too_many_sections`
 *   POST /api/forum/sections/:id/edit       { name?, about?, starts?, listed?, position?, archived? } → { section }
 *
 * A section: { id, starter, name, about, position, starts, listed, archived } (starter's name: @beanpool/core
 * forumSectionName). A topic: { id, sectionId, title, writer: { publicKey, name }, place, lang, replyCount, lastActivityAt,
 * createdAt, pinned, closed, removed, hidden }. A post: { id, topicId, number, writer, words, quotes, lang, createdAt, editedAt,
 * removed, photos, hidden, linksOn } (a removed one's words are empty and its photos 0; so are a hidden one's, but to its
 * writer and the moderators; `linksOn` false: a new writer's links are plain text). The front adds { moderator,
 * firstLooksWaiting, firstTopicWaits, linksOn } for the signer.
 *
 * All 404 `feature_off` while the owners have the forum switched off (routes/profile-feature-gate.ts). No route here reads
 * `checkAdminAuth`, so neither an automation token nor a Settings session reaches one.
 */
import crypto from 'node:crypto';
import Router from '@koa/router';
import { isNodeMember, readsAsMember, assertMemberActive, getNodeRole, moderationNoticesCb, forumNoticeCb } from '../state-engine.js';
import { respondProfileRefusal } from './profile-feature-gate.js';
import { memberErrorText } from './member-error-text.js';
import { parseDataUrl } from '../storage/image-columns.js';
import {
    ForumRefusal, closeForumTopic, createForumSection, editForumPost, editForumSection, followTopic, forumFront, forumListTag, forumPhoto, forumTopic,
    forumTopics, markForumTold, moveForumTopic, pinForumTopic, readTopic, removeForumPost, replyInForum, startForumTopic,
} from '../engine/forum.js';
import { noteForumReader, tellForumReply, tellForumTopic } from '../engine/forum-notices.js';
import { ForumSearchRefusal, FORUM_SEARCH_OFFSET_MAX, searchForum } from '../engine/forum-search.js';
import { FORUM_LIMITS, word } from '@beanpool/core';
import {
    firstLookPhoto, listFirstLooks, myFirstLook, noFirstLook, okFirstLook, tellFirstLookWaiting, withdrawFirstLook,
} from '../engine/forum-first-look.js';
import type { RouteDeps } from './types.js';

const ONLY_MEMBERS = word('Only a member of this community can read its forum.');
const PAUSED = word('Your account here is paused for now, so you can’t read or write in the forum.');
const STANDBY = word('This server is a standby copy of the community, so it can’t take this. Please try again at the community’s own address.');

function answer(ctx: any, status: number, error: string, code: string): void {
    ctx.status = status;
    ctx.body = { error, code };
}

/** A member's key, or null once the refusal is written. Not yet the test for reading: reader() and writer() add theirs. */
function member(ctx: any): string | null {
    const key = ctx.state?.actor as string | undefined;
    if (!key) { answer(ctx, 401, word('A signed request is required.'), 'unsigned'); return null; }
    if (!isNodeMember(key)) { answer(ctx, 403, ONLY_MEMBERS, 'not_member'); return null; }
    return key;
}

/**
 * The key of a member who reads as one (readsAsMember: not 'disabled' by an admin's or a report's pause or a community
 * vote, nor 'suspended'), or null once the refusal is written. While suspended, a member sees what a non-member sees
 * (Marty, 26 Sep): the forum is community content, every topic, post, photo and writer's name.
 */
function reader(ctx: any): string | null {
    const key = member(ctx);
    if (!key) return null;
    if (!readsAsMember(key)) { answer(ctx, 403, PAUSED, 'not_active'); return null; }
    return key;
}

/** An active member's key for a write, on the main server, or null once the refusal is written. */
function writer(ctx: any): string | null {
    const key = member(ctx);
    if (!key) return null;
    try {
        assertMemberActive(key);
    } catch {
        answer(ctx, 403, PAUSED, 'not_active');
        return null;
    }
    if (getNodeRole() !== 'primary') { answer(ctx, 503, STANDBY, 'standby'); return null; }
    return key;
}

/** A refusal in the member's words: the forum's own, or a mute, a standby or a photo budget (profile-feature-gate.ts). */
function refused(ctx: any, e: unknown): void {
    // The day's searches spent: when the oldest one counted leaves the day.
    if (e instanceof ForumSearchRefusal) ctx.set('Retry-After', String(e.retryAfterSec));
    if (e instanceof ForumRefusal) return answer(ctx, e.status, e.message, e.code);
    if (respondProfileRefusal(ctx, e)) return;
    ctx.status = 400;
    ctx.body = { error: memberErrorText(e, word('Couldn’t save this in the forum.')) };
}

function whole(raw: unknown, fallback: number, max: number): number | null {
    if (raw === undefined) return fallback;
    if (typeof raw !== 'string' || !/^\d{1,7}$/.test(raw)) return null;
    const n = Number(raw);
    return n > max ? null : n;
}

/** Runs `fn` for a read, answering a refusal. */
function read(ctx: any, fn: (key: string) => unknown): void {
    ctx.set('Cache-Control', 'no-store');
    const key = reader(ctx);
    if (!key) return;
    try {
        ctx.body = fn(key);
    } catch (e) {
        refused(ctx, e);
    }
}

/** Runs `fn` for a write, answering `status` with what it returns, or a refusal. */
function write(ctx: any, status: number, fn: (key: string, body: any) => unknown): void {
    const key = writer(ctx);
    if (!key) return;
    const body = ctx.request.body && typeof ctx.request.body === 'object' ? ctx.request.body : {};
    try {
        const out = fn(key, body);
        ctx.status = status;
        ctx.body = out;
    } catch (e) {
        refused(ctx, e);
    }
}

export function createForumRoutes(_deps: RouteDeps): Router {
    const router = new Router();

    router.get('/api/forum', (ctx) => read(ctx, (key) => forumFront(key)));

    router.get('/api/forum/topics', (ctx) => {
        const key = reader(ctx);
        if (!key) return;
        const { section } = ctx.query;
        const offset = whole(ctx.query.offset, 0, 100_000);
        if ((section !== undefined && typeof section !== 'string') || offset === null) return answer(ctx, 400, 'section is one id; offset a whole number.', 'bad_request');
        // `private`: the answer varies by member (their blocks, their role) and only a signed member may read it. What was
        // asked goes in hashed, never as sent: a header takes no character past Latin-1, and request text is no header's.
        const asked = crypto.createHash('sha256').update(`${section ?? ''}\n${offset}`).digest('hex').slice(0, 16);
        const etag = `W/"forum-topics-${forumListTag(key)}-${asked}"`;
        ctx.set('ETag', etag);
        ctx.set('Cache-Control', 'private, max-age=0, must-revalidate');
        const inm = ctx.get('If-None-Match');
        if (inm && inm.replace(/^W\//, '') === etag.replace(/^W\//, '')) { ctx.status = 304; return; }
        try {
            ctx.body = forumTopics(key, { sectionId: section as string | undefined, offset });
        } catch (e) {
            refused(ctx, e);
        }
    });

    router.get('/api/forum/topics/:id', (ctx) => {
        const after = whole(ctx.query.after, 0, 1_000_000);
        if (after === null) return answer(ctx, 400, 'after is a whole number.', 'bad_request');
        read(ctx, (key) => {
            const out = forumTopic(key, ctx.params.id, after);
            // Reading it now: its replies' doorbell reaches them for a while (engine/forum-notices.ts), following it or not.
            noteForumReader(ctx.params.id, key);
            return out;
        });
    });

    // A member's search (slice F6): counted against their day's searches once the words are good, so a refusal costs none.
    router.get('/api/forum/search', (ctx) => {
        const offset = whole(ctx.query.offset, 0, FORUM_SEARCH_OFFSET_MAX);
        if (offset === null || Array.isArray(ctx.query.q)) return answer(ctx, 400, 'q is one text; offset a whole number.', 'bad_request');
        read(ctx, (key) => searchForum(key, ctx.query.q ?? '', offset));
    });

    router.get('/api/forum/posts/:id/photos/:n', (ctx) => {
        const key = reader(ctx);
        if (!key) return;
        const n = whole(ctx.params.n, -1, FORUM_LIMITS.photos - 1);
        let data: string | null = null;
        try {
            data = n === null || n < 0 ? null : forumPhoto(key, ctx.params.id, n);
        } catch (e) {
            if (!(e instanceof ForumRefusal)) throw e;
        }
        const parsed = data ? parseDataUrl(data) : null;
        if (!parsed) return answer(ctx, 404, word('This photo isn’t here any more.'), 'not_found');
        // Members' bytes: kept by the app that fetched them, never by a shared cache.
        ctx.set('Cache-Control', 'private, max-age=3600');
        ctx.type = parsed.mime;
        ctx.body = Buffer.from(parsed.base64, 'base64');
    });

    router.post('/api/forum/told', (ctx) => write(ctx, 200, (key) => { markForumTold(key); return { told: true }; }));
    router.post('/api/forum/topics', (ctx) => {
        write(ctx, 201, (key, body) => startForumTopic(key, body));
        // A new member's first topic waits for a look (slice F2): 202, and every moderator hears one is waiting.
        const out = ctx.body as { waiting?: any } | undefined;
        if (ctx.status === 201 && out?.waiting) {
            ctx.status = 202;
            tellFirstLookWaiting(moderationNoticesCb(), out.waiting);
        } else if (ctx.status === 201) {
            tellForumTopic(forumNoticeCb());
        }
    });
    router.post('/api/forum/topics/:id/replies', (ctx) => {
        write(ctx, 201, (key, body) => ({ post: replyInForum(key, ctx.params.id, body) }));
        // Its followers and the people it mentions are told, and open apps hear it (slice F5).
        const post = (ctx.body as { post?: any } | undefined)?.post;
        if (ctx.status === 201 && post) {
            tellForumReply(forumNoticeCb(), { id: post.id, topicId: post.topicId, number: post.number, writer: post.writer.publicKey, words: post.words, quotes: post.quotes });
        }
    });
    router.post('/api/forum/topics/:id/follow', (ctx) => write(ctx, 200, (key, body) => followTopic(key, ctx.params.id, body.follow)));
    router.post('/api/forum/topics/:id/read', (ctx) => write(ctx, 200, (key, body) => readTopic(forumNoticeCb(), key, ctx.params.id, body.upTo)));
    router.post('/api/forum/topics/:id/close', (ctx) => write(ctx, 200, (key) => ({ topic: closeForumTopic(key, ctx.params.id) })));
    router.post('/api/forum/topics/:id/pin', (ctx) => write(ctx, 200, (key, body) => {
        if (typeof body.pinned !== 'boolean') throw new ForumRefusal(400, 'bad_request', 'pinned is true or false.');
        return { topic: pinForumTopic(key, ctx.params.id, body.pinned) };
    }));
    router.post('/api/forum/topics/:id/move', (ctx) => write(ctx, 200, (key, body) => ({ topic: moveForumTopic(key, ctx.params.id, body.sectionId) })));
    router.post('/api/forum/posts/:id/edit', (ctx) => write(ctx, 200, (key, body) => editForumPost(key, ctx.params.id, body)));
    router.post('/api/forum/posts/:id/remove', (ctx) => write(ctx, 200, (key) => { removeForumPost(key, ctx.params.id); return { ok: true }; }));
    router.post('/api/forum/sections', (ctx) => write(ctx, 201, (key, body) => ({ section: createForumSection(key, body) })));
    router.post('/api/forum/sections/:id/edit', (ctx) => write(ctx, 200, (key, body) => ({ section: editForumSection(key, ctx.params.id, body) })));

    // ── First looks (slice F2, engine/forum-first-look.ts) ──
    router.get('/api/forum/first-looks', (ctx) => read(ctx, (key) => listFirstLooks(key)));
    router.get('/api/forum/first-looks/mine', (ctx) => read(ctx, (key) => myFirstLook(key)));
    router.get('/api/forum/first-looks/:id/photos/:n', (ctx) => {
        const key = reader(ctx);
        if (!key) return;
        const n = whole(ctx.params.n, -1, FORUM_LIMITS.photos - 1);
        const data = n === null || n < 0 ? null : firstLookPhoto(key, ctx.params.id, n);
        const parsed = data ? parseDataUrl(data) : null;
        if (!parsed) return answer(ctx, 404, word('This photo isn’t here any more.'), 'not_found');
        // Seen by a moderator or its writer only, before it is anyone's to see: never kept by any cache.
        ctx.set('Cache-Control', 'private, no-store');
        ctx.type = parsed.mime;
        ctx.body = Buffer.from(parsed.base64, 'base64');
    });
    router.post('/api/forum/first-looks/:id/ok', (ctx) => {
        write(ctx, 200, (key) => okFirstLook(moderationNoticesCb(), key, ctx.params.id));
        if (ctx.status === 200) tellForumTopic(forumNoticeCb());
    });
    router.post('/api/forum/first-looks/:id/no', (ctx) => write(ctx, 200, (key, body) => { noFirstLook(moderationNoticesCb(), key, ctx.params.id, body.reason); return { ok: true }; }));
    router.post('/api/forum/first-looks/:id/withdraw', (ctx) => write(ctx, 200, (key) => { withdrawFirstLook(key, ctx.params.id); return { ok: true }; }));

    return router;
}
