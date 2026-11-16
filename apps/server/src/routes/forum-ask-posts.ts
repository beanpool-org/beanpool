/**
 * The asker's half of forum posts on an Ask to join (slice F11; scratch/fable-design/DESIGN-forums-fable.md §13), on the
 * worldwide forum only (`forum` and `forumPublic`; anywhere else 404 `not_here`). engine/forum-ask-posts.ts holds the rules.
 *
 *   GET /api/forum/ask-posts   → { secret, posts: [{ postId, topicId, number, title }] }
 *
 * Signed by a member who reads as one (a non-member 403 `not_member`, a paused member 403 `not_active`, unsigned 401): their
 * secret, made now if they have none (a standby makes none: 503 `standby`), and their own posts anyone on the web can read
 * now, newest first, 20 at most, to pick up to three from. The secret is the signer's own and only theirs: never cached
 * (`no-store`), never in a public read, and never sent to the community they ask (that community gets it in the request and
 * keeps only the proofs it makes with it: routes/knocks.ts).
 *
 * 404 `feature_off` while the owners have the forum switched off (routes/profile-feature-gate.ts: every /api/forum route).
 */
import Router from '@koa/router';
import { word } from '@beanpool/core';
import { isNodeMember, readsAsMember } from '../state-engine.js';
import { forumPublicOn } from '../engine/forum-public.js';
import { forumAskPostsOf, forumProofSecret } from '../engine/forum-ask-posts.js';

function answer(ctx: any, status: number, error: string, code: string): void {
    ctx.status = status;
    ctx.body = { error, code };
}

export function createForumAskPostsRoutes(): Router {
    const router = new Router();

    router.get('/api/forum/ask-posts', (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        if (!forumPublicOn()) return answer(ctx, 404, word('Only the worldwide community’s forum has posts you can add to a request to join.'), 'not_here');
        const key = ctx.state?.actor as string | undefined;
        if (!key) return answer(ctx, 401, word('A signed request is required.'), 'unsigned');
        if (!isNodeMember(key)) return answer(ctx, 403, word('Only a member of this community can read its forum.'), 'not_member');
        if (!readsAsMember(key)) return answer(ctx, 403, word('Your account here is paused for now, so you can’t read or write in the forum.'), 'not_active');
        const secret = forumProofSecret(key);
        if (!secret) {
            return answer(ctx, 503, word('This server is a standby copy of the community, so it can’t take this. Please try again at the community’s own address.'), 'standby');
        }
        ctx.body = { secret, posts: forumAskPostsOf(key) };
    });

    return router;
}
