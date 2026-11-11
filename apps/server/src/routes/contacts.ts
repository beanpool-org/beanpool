/**
 * A member's locked contacts list (scratch/fable-design/DESIGN-private-contacts-fable.md §4.4, slice C1; the store is
 * engine/contact-copies.ts). Every route is the signer's own copy: none names an owner, so nobody reads or writes anyone
 * else's, admins and owners included.
 *
 *   GET    /api/contacts/copy   → { header, signature, nonce, sealed } of the signer's copy | 404 no_copy
 *   PUT    /api/contacts/copy   { header, signature, nonce, sealed } → { seq } | { seq, code: exists }; 400 bad_copy,
 *                               403 not_yours, 409 stale_copy { seq } | node_full, 413 copy_too_big, 429 too_many_saves
 *   DELETE /api/contacts/copy   → { deleted }: the signer's copy removed, with a tombstone
 *
 * Refusals, before anything is read or written: unsigned 401; a key that isn't an active member's here (a visitor, a
 * guest, a stranger, a suspended or removed member) 403 `not_member`; where the owners switched the community's copies
 * off, GET and PUT 404 `contacts_off` (a DELETE still removes the member's own); a standby's writes 409 `standby`
 * (routes/standby-ledger-gate.ts, and the engine's assertPlainTablesWritable), while a standby still answers a GET from
 * the copy it keeps. The body is capped at 1 MiB before it is read (https-server.ts ROUTE_BODY_LIMITS).
 */
import Router from '@koa/router';
import { word } from '@beanpool/core';
import { getMember, isVisitorKey } from '../state-engine.js';
import { STANDBY_CODE } from '../config/node-role.js';
import { ContactCopyError, deleteContactCopy, readContactCopyOf, saveContactCopy } from '../engine/contact-copies.js';

const NOT_MEMBER = word('Not an active member of this community.');

function answer(ctx: any, status: number, error: string, code: string, extra?: Record<string, unknown>): void {
    ctx.status = status;
    ctx.body = { ...(extra ?? {}), error, code };
}

/** The signing member, once every refusal above has been written; null when one was. */
function member(ctx: any): string | null {
    ctx.set('Cache-Control', 'private, no-store');
    const actor = ctx.state?.actor as string | undefined;
    if (!actor) { answer(ctx, 401, 'Sign this request with your member key.', 'unsigned'); return null; }
    const key = actor.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(key)) { answer(ctx, 400, 'The key that signed this request must be 64 hexadecimal characters.', 'bad_key'); return null; }
    const m = getMember(key);
    if (!m || m.status !== 'active' || isVisitorKey(key)) { answer(ctx, 403, NOT_MEMBER, 'not_member'); return null; }
    return key;
}

async function asMember(ctx: any, fn: (actor: string, body: Record<string, unknown>) => unknown): Promise<void> {
    const actor = member(ctx);
    if (!actor) return;
    const body = (ctx.requestBody && typeof ctx.requestBody === 'object' && !Array.isArray(ctx.requestBody) ? ctx.requestBody : {}) as Record<string, unknown>;
    try {
        ctx.status = 200;
        ctx.body = fn(actor, body);
    } catch (e) {
        if (e instanceof ContactCopyError) return answer(ctx, e.status, e.message, e.code, e.extra);
        if ((e as { code?: unknown })?.code === STANDBY_CODE) return answer(ctx, 409, (e as Error).message, STANDBY_CODE);
        throw e;
    }
}

export function createContactsRoutes(): Router {
    const router = new Router();
    router.get('/api/contacts/copy', (ctx) => asMember(ctx, (actor) => readContactCopyOf(actor)));
    router.put('/api/contacts/copy', (ctx) => asMember(ctx, (actor, body) => {
        const out = saveContactCopy(actor, body);
        return out.exists ? { seq: out.seq, code: 'exists' } : { seq: out.seq };
    }));
    router.delete('/api/contacts/copy', (ctx) => asMember(ctx, (actor) => deleteContactCopy(actor)));
    return router;
}
