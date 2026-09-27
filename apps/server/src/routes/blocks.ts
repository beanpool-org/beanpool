/**
 * A member's own block list, kept by the community for the account (engine/member-blocks.ts), so the web app has it back
 * on any browser after signing in and keeps nothing about it in the browser.
 *
 *   GET  /api/blocks                                → { blocked: [{ publicKey, blockedAt }], max }, oldest first
 *   POST /api/blocks        { targetPubkey }        → { success: true, added: [keys], blocked, max }
 *                           { targetPubkeys: [..] } (the web app's one-time move of a list it kept in the browser)
 *   POST /api/blocks/remove { targetPubkey }        → { success: true, removed: boolean, blocked, max }
 *   POST /api/blocks/clear                          → { success: true, removed: count, blocked: [], max }
 *
 * ## Only ever the signer's own
 *
 * No route takes the owner from the query or the body: the member is `ctx.state.actor`, verified by the real
 * `requireSignature` middleware, whose spoof check refuses a body naming another key as the one acting. The read is a
 * gated read (not on the public allowlist): unsigned 401, and a signed key that is no member here 403 from the middleware.
 * The checks here answer the same way where the middleware lets a request through (a node with ENFORCE_READ_AUTH=false,
 * and a write, which the middleware does not hold to membership): the read with the read gate's own test, as
 * /api/notices does, and the writes with the act test, answered in the words the middleware answers a visitor's row with.
 * A suspended member keeps and changes their own list. Each answer holds the signer's own list and nothing about anyone
 * else's: whether someone else blocked anyone is never read here.
 *
 * A change rings a bare doorbell (`{ type: 'blocklist_updated' }`) on the signer's own sockets only, so their other tabs
 * and devices read the list again. Nothing goes to anyone else, and nothing is written to the activity feed.
 *
 * ## The main server only, for a change
 *
 * A standby answers the read from its copy but refuses a change, 503 `standby`, and writes nothing: its copy follows the
 * main server's, which would not have it. The community's address reaches the main server.
 */
import Router from '@koa/router';
import { passesReadGate, isNodeMember, getNodeRole, broadcast } from '../state-engine.js';
import { NOT_A_MEMBER_CODE, NOT_A_MEMBER_ERROR } from '../engine/members.js';
import { listBlocks, addBlocks, removeBlock, clearBlocks, BlockRefusal, MEMBER_BLOCKS_MAX } from '../engine/member-blocks.js';
import { isMemberKeySpelling, BAD_KEY_CODE, BAD_KEY_ERROR } from '../engine/member-key.js';
import type { RouteDeps } from './types.js';

/** The verified signer, or undefined once the refusal is written. */
function signer(ctx: any): string | undefined {
    const actor = ctx.state.actor as string | undefined;
    if (!actor) {
        ctx.status = 401;
        ctx.body = { error: 'A signed request is required' };
        return undefined;
    }
    return actor;
}

/** The signer of a change, when they may make one here, or undefined once the refusal is written. */
function changer(ctx: any): string | undefined {
    const actor = signer(ctx);
    if (!actor) return undefined;
    if (!isNodeMember(actor)) {
        ctx.status = 403;
        ctx.body = { error: NOT_A_MEMBER_ERROR, code: NOT_A_MEMBER_CODE };
        return undefined;
    }
    if (getNodeRole() !== 'primary') {
        ctx.status = 503;
        ctx.body = { error: 'This server is a standby copy of the community, not its main server. Blocks are changed on the main server.', code: 'standby' };
        return undefined;
    }
    return actor;
}

/** The signer's list as every answer carries it, private. */
function answer(ctx: any, actor: string, extra: Record<string, unknown> = {}): void {
    ctx.set('Cache-Control', 'private, no-store');
    ctx.body = { ...extra, blocked: listBlocks(actor), max: MEMBER_BLOCKS_MAX };
}

/** The doorbell on the signer's own sockets, after a change. */
function ring(actor: string): void {
    try { broadcast({ type: 'blocklist_updated' }, [actor]); } catch (e: any) { console.warn('[Blocks] doorbell failed:', e?.message || e); }
}

function refuse(ctx: any, status: number, error: string, code?: string): void {
    ctx.status = status;
    ctx.body = code ? { error, code } : { error };
}

export function createBlockRoutes(_deps: RouteDeps): Router {
    const router = new Router();

    router.get('/api/blocks', async (ctx) => {
        const actor = signer(ctx);
        if (!actor) return;
        if (!passesReadGate(actor)) return refuse(ctx, 403, 'Read access requires a member identity');
        answer(ctx, actor);
    });

    router.post('/api/blocks', async (ctx) => {
        const actor = changer(ctx);
        if (!actor) return;
        const body = (ctx as any).requestBody || {};
        const one = body.targetPubkey;
        const many = body.targetPubkeys;
        let keys: string[];
        if (one !== undefined && many === undefined) {
            keys = [one];
        } else if (many !== undefined && one === undefined && Array.isArray(many) && many.length > 0 && many.length <= MEMBER_BLOCKS_MAX) {
            keys = many;
        } else {
            return refuse(ctx, 400, `Send targetPubkey, the key to block, or targetPubkeys, a list of 1 to ${MEMBER_BLOCKS_MAX} keys.`);
        }
        if (!keys.every(k => isMemberKeySpelling(k))) return refuse(ctx, 400, BAD_KEY_ERROR, BAD_KEY_CODE);
        let added: string[];
        try {
            added = addBlocks(actor, keys);
        } catch (e) {
            if (e instanceof BlockRefusal) return refuse(ctx, e.status, e.message, e.code);
            throw e;
        }
        if (added.length > 0) ring(actor);
        answer(ctx, actor, { success: true, added });
    });

    router.post('/api/blocks/remove', async (ctx) => {
        const actor = changer(ctx);
        if (!actor) return;
        const target = ((ctx as any).requestBody || {}).targetPubkey;
        if (!isMemberKeySpelling(target)) return refuse(ctx, 400, BAD_KEY_ERROR, BAD_KEY_CODE);
        const removed = removeBlock(actor, target);
        if (removed) ring(actor);
        answer(ctx, actor, { success: true, removed });
    });

    router.post('/api/blocks/clear', async (ctx) => {
        const actor = changer(ctx);
        if (!actor) return;
        const removed = clearBlocks(actor);
        if (removed > 0) ring(actor);
        answer(ctx, actor, { success: true, removed });
    });

    return router;
}
