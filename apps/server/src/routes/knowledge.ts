/**
 * Local knowledge, read in Learn (slice K1; scratch/fable-design/DESIGN-local-knowledge-fable.md §4.2 as amended). engine/
 * knowledge.ts holds the rules; every route is signed, and the actor is always the signer, never a body field.
 *
 * A member of this community:
 *   GET  /api/knowledge/front                       → { total, pinned: [row], topics: [{ id, count, rows: [row × 3] }] }
 *   GET  /api/knowledge/front?topic=<id>&offset=<n> → { topic, count, rows, next }   (every row of one topic, 50 a page)
 *   GET  /api/knowledge/front?q=<words>             → { total, rows }                 (best match first, at most 30)
 *        A row is what the row card draws (id, title, first line, topic, photo, checkedAt, helped, pinned, outdated), never
 *        the body: one page is read whole through GET /api/marketplace/posts?type=knowledge&id=…
 * An owner or admin (nodeRoleOf); anyone else 403 `admins_only`:
 *   POST /api/knowledge/posts                        { title, body, topic, place?, sources?, lang?, photos? } → 201 { post }
 *   POST /api/knowledge/posts/:id/edit               { title, body, topic, place?, sources?, lang? } → { post }
 *   POST /api/knowledge/posts/:id/checked            "Still right" → { post }
 *   POST /api/knowledge/posts/:id/outdated/clear     → { post }
 *   POST /api/knowledge/posts/:id/take-down          { reasonCategory? } → { ok: true }   (Settings' own removal)
 * Its writer, an owner or an admin; anyone else 403 `writer_or_admins`:
 *   POST /api/knowledge/posts/:id/outdated           { note? } → { post }
 * A page that isn't showing is 404 `not_found`.
 *
 * The waiting list (slice K3; engine/knowledge-drafts.ts). A member:
 *   POST /api/knowledge/drafts                       { title, body, topic, place?, sources?, lang?, photos? } → 201 { draft }
 *        (409 `publish_instead` for an owner or admin; 429 `too_many_waiting`, `sent_enough_today`; a mute, a new account's
 *        limits and the photo budget as for posting)
 *   GET  /api/knowledge/drafts/mine                  → { waiting: [draft], answered: [draft] }   (a paused member reads too)
 *   POST /api/knowledge/drafts/:id/withdraw          → { ok: true } | 404 `not_found`             (paused or not)
 * An owner or admin; anyone else 403 `admins_only`:
 *   GET  /api/knowledge/drafts?limit&offset          → { drafts: [row], total, limit, offset }  (the longest waiting first)
 *   GET  /api/knowledge/drafts/:id                   → { draft }  (whole, its photos as data URLs) | 404 `not_found`
 *   POST /api/knowledge/drafts/:id/approve           { title?, body?, topic?, place?, sources?, lang?, checkedSources?, photos? }
 *        → { post } | 404 `not_found` | 409 `already_answered`, `writer_paused` | 400 `sources_not_checked` (an assistant's)
 *   POST /api/knowledge/drafts/:id/no                { reason, words? } → { ok: true } | 404 | 409 `already_answered`
 *
 * All 404 `feature_off` where the `knowledge` switch is off (routes/profile-feature-gate.ts): the global community. A standby
 * refuses a write, 503 `standby`, and reads from its copy. Whoever passes the signature middleware here holds the key: no
 * route in this file reads `checkAdminAuth`, so neither an automation token nor a Settings session reaches one.
 */
import Router from '@koa/router';
import { adminDeletePost, broadcast, dispatchPushNotification, getMember, getNodeRole, isNodeMember, assertMemberActive } from '../state-engine.js';
import { respondProfileRefusal } from './profile-feature-gate.js';
import { memberErrorText } from './member-error-text.js';
import { routePhotosRefusal, photoRefusalText } from '../engine/avatar.js';
import { POST_PHOTO_FORMAT_ERROR } from '../engine/posts.js';
import { assertMayPost } from '../engine/probation.js';
import {
    KNOWLEDGE_WORDS, KnowledgeRefusal, assertMayTakeDownKnowledge, checksKnowledge, clearKnowledgeOutdated, confirmKnowledge, editKnowledge, knowledgeFront,
    knowledgeSearch, knowledgeTopicPage, markKnowledgeOutdated, publishKnowledge,
} from '../engine/knowledge.js';
import {
    DRAFT_WORDS, approveKnowledgeDraft, declineKnowledgeDraft, knowledgeCheckers, knowledgeDraftWhole, knowledgeDraftsToCheck,
    myKnowledgeDrafts, suggestKnowledge, withdrawKnowledgeDraft, type KnowledgeAnswer,
} from '../engine/knowledge-drafts.js';
import { keptNoticeDetails } from '../engine/kept-notices.js';
import { KNOWLEDGE_DRAFT_WORDS, KNOWLEDGE_LIMITS, isKnowledgeTopic, word, wordsFor, type KnowledgeDraftMine } from '@beanpool/core';
import type { RouteDeps } from './types.js';

// A refusal with a value in it, in English as a template wrote it, its sentence marked for the way out to find again in the
// member's language (member-words.ts).
const { t: tr } = wordsFor('en');

const ONLY_MEMBERS = word('Only a member of this community can read Learn.');
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;
const PAUSED = word('Your account here is paused for now, so you can’t change Local knowledge.');
const STANDBY = word('This server is a standby copy of the community, so it can’t take this. Please try again at the community’s own address.');

function answer(ctx: any, status: number, error: string, code: string): void {
    ctx.status = status;
    ctx.body = { error, code };
}

/** The signer, or null once the refusal is written. */
function signer(ctx: any): string | null {
    const actor = ctx.state?.actor as string | undefined;
    if (actor) return actor;
    answer(ctx, 401, word('A signed request is required.'), 'unsigned');
    return null;
}

/** A member's key (a paused one reads too), or null once the refusal is written. */
function member(ctx: any): string | null {
    const key = signer(ctx);
    if (!key) return null;
    if (!isNodeMember(key)) { answer(ctx, 403, ONLY_MEMBERS, 'not_member'); return null; }
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

/** Runs a write, answering its refusal in the member's words: the engine's own, or a limit's (profile-feature-gate.ts). */
function refused(ctx: any, e: unknown): void {
    if (e instanceof KnowledgeRefusal) return answer(ctx, e.status, e.message, e.code);
    if (respondProfileRefusal(ctx, e)) return;
    ctx.status = 400;
    ctx.body = { error: memberErrorText(e, word('Couldn’t save this page of Local knowledge.')) };
}

function wholeQuery(raw: unknown, fallback: number, max: number): number | null {
    if (raw === undefined) return fallback;
    if (typeof raw !== 'string' || !/^\d{1,7}$/.test(raw)) return null;
    const n = Number(raw);
    return n > max ? null : n;
}

export function createKnowledgeRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const send = deps.broadcast ?? ((event: any, recipients?: string[]) => { broadcast(event, recipients); });

    router.get('/api/knowledge/front', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const key = member(ctx);
        if (!key) return;
        const { q, topic } = ctx.query;
        if ((q !== undefined && typeof q !== 'string') || (topic !== undefined && typeof topic !== 'string') || (q !== undefined && topic !== undefined)) {
            return answer(ctx, 400, 'Give q or topic, once each, not both.', 'bad_request');
        }
        if (typeof q === 'string') {
            const words = q.trim();
            if (!words || words.length > 100) return answer(ctx, 400, 'q is 1 to 100 characters.', 'bad_request');
            ctx.body = knowledgeSearch(key, words);
            return;
        }
        if (typeof topic === 'string') {
            if (!isKnowledgeTopic(topic)) return answer(ctx, 400, 'topic is one of the Local knowledge topics.', 'bad_request');
            const offset = wholeQuery(ctx.query.offset, 0, 1_000_000);
            if (offset === null) return answer(ctx, 400, 'offset is a whole number.', 'bad_request');
            ctx.body = knowledgeTopicPage(key, topic, offset);
            return;
        }
        if (ctx.query.offset !== undefined) return answer(ctx, 400, 'offset goes with topic.', 'bad_request');
        ctx.body = knowledgeFront(key);
    });

    router.post('/api/knowledge/posts', async (ctx) => {
        const key = writer(ctx);
        if (!key) return;
        const body = ((ctx as any).requestBody || {}) as Record<string, unknown>;
        const photos = body.photos;
        if (Array.isArray(photos)) {
            if (photos.length > KNOWLEDGE_LIMITS.photos) return answer(ctx, 400, tr('At most {n} photos.', { n: KNOWLEDGE_LIMITS.photos }), 'too_many_photos');
            const photoRefusal = routePhotosRefusal(photos);
            if (photoRefusal) return answer(ctx, 400, photoRefusalText(photoRefusal, POST_PHOTO_FORMAT_ERROR), 'bad_photos');
        }
        try {
            // A new account's limits, as every post's (engine/probation.ts): its photos count.
            assertMayPost(key, Array.isArray(photos) ? photos.length : 0);
            const post = publishKnowledge(send, key, body as any);
            ctx.status = 201;
            ctx.body = { post };
        } catch (e) {
            refused(ctx, e);
        }
    });

    router.post('/api/knowledge/posts/:id/edit', async (ctx) => {
        const key = writer(ctx);
        if (!key) return;
        try {
            ctx.body = { post: editKnowledge(send, key, ctx.params.id, ((ctx as any).requestBody || {}) as Record<string, unknown>) };
        } catch (e) {
            refused(ctx, e);
        }
    });

    router.post('/api/knowledge/posts/:id/checked', async (ctx) => {
        const key = writer(ctx);
        if (!key) return;
        try {
            ctx.body = { post: confirmKnowledge(send, key, ctx.params.id) };
        } catch (e) {
            refused(ctx, e);
        }
    });

    router.post('/api/knowledge/posts/:id/outdated', async (ctx) => {
        const key = writer(ctx);
        if (!key) return;
        try {
            ctx.body = { post: markKnowledgeOutdated(send, key, ctx.params.id, (((ctx as any).requestBody || {}) as Record<string, unknown>).note) };
        } catch (e) {
            refused(ctx, e);
        }
    });

    router.post('/api/knowledge/posts/:id/outdated/clear', async (ctx) => {
        const key = writer(ctx);
        if (!key) return;
        try {
            ctx.body = { post: clearKnowledgeOutdated(send, key, ctx.params.id) };
        } catch (e) {
            refused(ctx, e);
        }
    });

    // ── The waiting list (slice K3) ────────────────────────────────────────────────────────────

    /**
     * One push per member's suggestion to each owner and admin (§5.6 as amended): the lock screen's fixed words, and in its
     * details who and what, landing on To check. None for an assistant's draft: the admin asked for it.
     */
    const tellCheckers = (sender: string, draft: KnowledgeDraftMine): void => {
        const to = knowledgeCheckers().filter((pk) => pk !== sender);
        if (to.length === 0) return;
        const name = getMember(sender)?.callsign || '';
        try {
            dispatchPushNotification(to, sender, tr(KNOWLEDGE_DRAFT_WORDS.suggestedTitle), tr(KNOWLEDGE_DRAFT_WORDS.suggestedBody, { name, title: draft.title }),
                { screen: 'learn-check', draftId: draft.id }, 'marketplace', 'knowledge.suggested');
        } catch { /* the bell's count says so all the same */ }
    };

    /** The member whose suggestion was answered: their kept notice's words, as a push that names its kept copy. */
    const tellSender = (a: KnowledgeAnswer, landing: Record<string, unknown>): void => {
        if (!a.notice) return;
        try {
            dispatchPushNotification([a.member], 'SYSTEM', a.notice.title, a.notice.body, { screen: 'learn-mine', draftId: a.draftId, ...landing },
                'marketplace', 'knowledge.answered', false, keptNoticeDetails([{ to: a.member, id: a.notice.id }]));
        } catch { /* it is kept */ }
    };

    /** An owner's or admin's key for a read, or null once the refusal is written. */
    const checker = (ctx: any): string | null => {
        const key = member(ctx);
        if (!key) return null;
        if (!checksKnowledge(key)) { answer(ctx, 403, KNOWLEDGE_WORDS.adminsOnly, 'admins_only'); return null; }
        return key;
    };

    router.post('/api/knowledge/drafts', async (ctx) => {
        const key = writer(ctx);
        if (!key) return;
        try {
            const draft = suggestKnowledge(key, ((ctx as any).requestBody || {}) as Record<string, unknown>);
            tellCheckers(key, draft);
            ctx.status = 201;
            ctx.body = { draft };
        } catch (e) {
            refused(ctx, e);
        }
    });

    // Before /:id, which would take "mine" for an id.
    router.get('/api/knowledge/drafts/mine', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const key = member(ctx);
        if (!key) return;
        ctx.body = myKnowledgeDrafts(key);
    });

    router.post('/api/knowledge/drafts/:id/withdraw', async (ctx) => {
        // Paused or not, a suggestion is theirs to take back.
        const key = member(ctx);
        if (!key) return;
        if (getNodeRole() !== 'primary') return answer(ctx, 503, STANDBY, 'standby');
        if (!withdrawKnowledgeDraft(key, ctx.params.id)) return answer(ctx, 404, DRAFT_WORDS.notWaiting, 'not_found');
        ctx.body = { ok: true };
    });

    router.get('/api/knowledge/drafts', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const key = checker(ctx);
        if (!key) return;
        const limit = wholeQuery(ctx.query.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
        const offset = wholeQuery(ctx.query.offset, 0, 1_000_000);
        if (limit === null || limit < 1 || offset === null) return answer(ctx, 400, `limit is 1 to ${MAX_LIST_LIMIT}, and offset a whole number.`, 'bad_request');
        ctx.body = { ...knowledgeDraftsToCheck(limit, offset), limit, offset };
    });

    router.get('/api/knowledge/drafts/:id', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const key = checker(ctx);
        if (!key) return;
        const draft = knowledgeDraftWhole(ctx.params.id);
        if (!draft) return answer(ctx, 404, DRAFT_WORDS.notWaiting, 'not_found');
        ctx.body = { draft };
    });

    router.post('/api/knowledge/drafts/:id/approve', async (ctx) => {
        const key = writer(ctx);
        if (!key) return;
        try {
            const a = approveKnowledgeDraft(send, key, ctx.params.id, ((ctx as any).requestBody || {}) as Record<string, unknown>);
            tellSender(a, { postId: a.post.id });
            ctx.body = { post: a.post };
        } catch (e) {
            refused(ctx, e);
        }
    });

    router.post('/api/knowledge/drafts/:id/no', async (ctx) => {
        const key = writer(ctx);
        if (!key) return;
        const { reason, words } = ((ctx as any).requestBody || {}) as { reason?: unknown; words?: unknown };
        try {
            tellSender(declineKnowledgeDraft(key, ctx.params.id, reason, words), {});
            ctx.body = { ok: true };
        } catch (e) {
            refused(ctx, e);
        }
    });

    router.post('/api/knowledge/posts/:id/take-down', async (ctx) => {
        const key = writer(ctx);
        if (!key) return;
        try {
            const id = assertMayTakeDownKnowledge(key, ctx.params.id);
            // Settings' own removal (state-engine.ts adminDeletePost): its writer reads the usual notice, with the reason, and
            // no name; every open report on it is closed and its reporter told.
            const { reasonCategory } = ((ctx as any).requestBody || {}) as { reasonCategory?: unknown };
            if (!adminDeletePost(id, { reasonCategory: typeof reasonCategory === 'string' ? reasonCategory : null })) {
                return answer(ctx, 404, word('This page of Local knowledge isn’t showing any more.'), 'not_found');
            }
            ctx.body = { ok: true };
        } catch (e) {
            refused(ctx, e);
        }
    });

    return router;
}
