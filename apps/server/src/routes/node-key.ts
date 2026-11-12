/**
 * A community's server, as other servers see it (messages across communities X1: scratch/fable-design/
 * DESIGN-cross-chat-voice-fable.md §3.2, §11 row X1; the format, @beanpool/core node-request-signing.ts).
 *
 *   GET  /api/node/key    public            → the key document: { v, key, validUntil, previousKeys, sig }
 *                                             503 no_node_key while this server has no node key
 *   POST /api/node/check  a server's signed  { items: RelayItem[] (at most NODE_CHECK_ITEMS_MAX) }
 *                         request only      → { origin, key, items: [{ itemId, ok, reason? }] }
 *
 * `/api/node/key` is what another server fetches, over TLS from this server's name, to check a request this one signed
 * (engine/node-signature.ts). The same answer for everyone, made at most once an hour (engine/node-key.ts).
 *
 * `/api/node/check` stores nothing. It answers what this server made of a server's signed request (the origin and key it
 * verified, by the real door: engine/node-signature.ts) and of each relay item in it, by the rules every item will meet
 * at the mailbox (X2): its form, the home rule (an envelope naming a home other than the server that signed the request
 * is dropped, `wrong-home`), whether it is for this server, the payload against its hash, the sender's signature
 * (@beanpool/core relay-envelope.ts checkRelayItem). So two operators can see that their servers can speak to each other
 * before any message crosses. It never says whether a recipient is a member here: nothing in it reads the members.
 */
import Router from '@koa/router';
import { checkRelayItem } from '@beanpool/core';
import { ownNodeKeyDocument } from '../engine/node-key.js';
import type { NodeOrigin } from '../engine/node-signature.js';
import { audienceStanding } from '../engine/own-addresses.js';

/** The most items one check may carry. */
export const NODE_CHECK_ITEMS_MAX = 16;

/** Whether `host` is one of this server's own names: an item for any other host is not for here. */
function isHere(host: string): boolean {
    return audienceStanding(host) === 'own';
}

export function createNodeKeyRoutes(): Router {
    const router = new Router();

    router.get('/api/node/key', async (ctx) => {
        let doc;
        try {
            doc = await ownNodeKeyDocument();
        } catch (e) {
            console.warn(`[NodeKey] The node key could not be read: ${e instanceof Error ? e.message : String(e)}`);
            doc = null;
        }
        if (!doc) {
            ctx.status = 503;
            ctx.set('Cache-Control', 'no-store');
            ctx.body = { error: 'This server has no node key yet.', code: 'no_node_key' };
            return;
        }
        ctx.set('Cache-Control', 'public, max-age=3600');
        ctx.body = doc;
    });

    router.post('/api/node/check', async (ctx) => {
        // Set only by the node signature door (https-server.ts requireNodeSignature): a request without one never gets here.
        const from = ctx.state.nodeOrigin as NodeOrigin | undefined;
        if (!from) {
            ctx.status = 401;
            ctx.body = { error: 'This path takes only requests signed by a community\'s server.', code: 'node_signature_missing' };
            return;
        }
        const items = ((ctx.request as unknown as { body?: { items?: unknown } }).body)?.items;
        if (!Array.isArray(items) || items.length > NODE_CHECK_ITEMS_MAX) {
            ctx.status = 400;
            ctx.body = { error: `items is a list of at most ${NODE_CHECK_ITEMS_MAX} relay items.`, code: 'bad_items' };
            return;
        }
        ctx.set('Cache-Control', 'no-store');
        ctx.body = {
            origin: from.origin,
            key: from.key,
            items: items.map((item: unknown) => {
                const verdict = checkRelayItem(item, { signedBy: from.origin, isHere });
                if (verdict.ok) return { itemId: verdict.item.envelope.itemId, ok: true };
                const id = (item as { envelope?: { itemId?: unknown } } | null)?.envelope?.itemId;
                return { itemId: typeof id === 'string' && id.length <= 64 ? id : null, ok: false, reason: verdict.reason };
            }),
        };
    });

    return router;
}
