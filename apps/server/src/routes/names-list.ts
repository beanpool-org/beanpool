/**
 * The names list (community modes slice 2): what an owner's or admin's phone reads and writes. The rules, the key and
 * what is logged: engine/names-list.ts. Every route is signed with the admin's own key, through the real signature
 * middleware; none takes a key from the body or the query to act as.
 *
 *   GET    /api/names/state                         → the key history, every share header (the box of one to this admin),
 *                                                     the admins and the key ids each holds, the write freeze, settings
 *   GET    /api/names/entries[?for=export]          → every entry, sealed, and every confirmation (logged: read | export)
 *   POST   /api/names/entries                       { id, ciphertext, keyId } → 201 { id }
 *   PUT    /api/names/entries/:id                   { ciphertext, keyId }     → { id }
 *   DELETE /api/names/entries/:id                   → { id } (409 entry_confirmed while a member is confirmed against it)
 *   POST   /api/names/generations                   { statement, signature, replay? } → 201 { id, n } | 200 { id, n, code: exists }
 *   POST   /api/names/shares                        { header, signature, box } → { to }
 *   POST   /api/names/confirmations                 { memberPubkey, entryId } → 201 { id, status }
 *   POST   /api/names/confirmations/:id/second      → { id, status }
 *   POST   /api/names/confirmations/:id/revoke      → { id, status }
 *   GET    /api/names/log?limit&offset              → { log, total, limit, offset }
 *   POST   /api/names/settings                      { twoAdminsToConfirm?, namesShownToMembers? } (an owner)
 *
 * Refusals, before anything is read or written: unsigned 401; a key that isn't an active member's here 403
 * `not_member`; a member, a moderator or a visitor 403 `admins_only`; the global node 404 `feature_off` (it keeps no
 * names list: nobody there is confirmed by name, design §5); a standby 409 `standby`, reads included, since a read
 * writes the access log, which is the main server's. Every admin's request first marks holders of the current key who
 * are no admin now (reconcileHolders).
 */
import Router from '@koa/router';
import { getMember, isVisitorKey } from '../state-engine.js';
import { getNodeProfile } from '../config/node-profile.js';
import { getNodeRole, STANDBY_CODE } from '../config/node-role.js';
import {
    NamesListError, assertNamesAdmin, reconcileHolders, namesState, readEntries, addEntry, editEntry, deleteEntry,
    addGeneration, addShare, confirmMember, secondConfirmation, revokeConfirmation, readNamesLog, setNamesSettings,
} from '../engine/names-list.js';
import type { RouteDeps } from './types.js';

const STANDBY_NAMES = 'This server is a standby copy of the community, not its main server. The names list opens on the main server, '
    + 'which logs who reads it; this copy keeps it, sealed, for a take-over.';
const GLOBAL_NAMES = 'The global community keeps no names list: nobody there is confirmed by name. Each local community keeps its own.';

const DEFAULT_LOG_LIMIT = 50;
const MAX_LOG_LIMIT = 200;

function answer(ctx: any, status: number, error: string, code: string): void {
    ctx.status = status;
    ctx.body = { error, code };
}

function wholeQuery(raw: unknown, fallback: number, max: number): number | null {
    if (raw === undefined) return fallback;
    if (typeof raw !== 'string' || !/^\d{1,7}$/.test(raw)) return null;
    const n = Number(raw);
    return n > max ? null : n;
}

/**
 * The signing admin, in the member table's spelling, once every refusal above has been written; null when one was.
 * Marks the holders of the current key who are no admin now before the handler runs.
 */
function admin(ctx: any): string | null {
    ctx.set('Cache-Control', 'no-store');
    if (getNodeProfile() === 'global') { answer(ctx, 404, GLOBAL_NAMES, 'feature_off'); return null; }
    const actor = ctx.state?.actor as string | undefined;
    if (!actor) { answer(ctx, 401, 'Sign this request with your member key.', 'unsigned'); return null; }
    const key = actor.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(key)) { answer(ctx, 400, 'The key that signed this request must be 64 hexadecimal characters.', 'bad_key'); return null; }
    const member = getMember(key);
    if (!member || member.status !== 'active' || isVisitorKey(key)) { answer(ctx, 403, 'Not an active member of this community.', 'not_member'); return null; }
    if (getNodeRole() !== 'primary') { answer(ctx, 409, STANDBY_NAMES, STANDBY_CODE); return null; }
    reconcileHolders();
    try {
        assertNamesAdmin(key);
    } catch (e) {
        respond(ctx, e);
        return null;
    }
    return key;
}

function respond(ctx: any, e: unknown): void {
    if (e instanceof NamesListError) return answer(ctx, e.status, e.message, e.code);
    if ((e as { code?: unknown })?.code === STANDBY_CODE) return answer(ctx, 409, STANDBY_NAMES, STANDBY_CODE);
    throw e;
}

/** Runs `fn` for the signing admin, answering a refusal in its own status and code. */
async function asAdmin(ctx: any, fn: (actor: string, body: Record<string, unknown>) => unknown, status = 200): Promise<void> {
    const actor = admin(ctx);
    if (!actor) return;
    const body = ((ctx as any).requestBody && typeof (ctx as any).requestBody === 'object' ? (ctx as any).requestBody : {}) as Record<string, unknown>;
    try {
        // Set first: a handler may answer with another success status of its own.
        ctx.status = status;
        const out = fn(actor, body);
        ctx.body = out;
    } catch (e) {
        respond(ctx, e);
    }
}

export function createNamesListRoutes(_deps: RouteDeps): Router {
    const router = new Router();

    router.get('/api/names/state', (ctx) => asAdmin(ctx, (actor) => namesState(actor)));

    router.get('/api/names/entries', (ctx) => asAdmin(ctx, (actor) => {
        const purpose = ctx.query.for;
        if (purpose !== undefined && purpose !== 'export') throw new NamesListError(400, 'bad_request', "'for' is export, or left out.");
        return readEntries(actor, purpose === 'export' ? 'export' : 'read');
    }));

    router.post('/api/names/entries', (ctx) => asAdmin(ctx, (actor, body) => addEntry(actor, body), 201));
    router.put('/api/names/entries/:id', (ctx) => asAdmin(ctx, (actor, body) => editEntry(actor, ctx.params.id, body)));
    router.delete('/api/names/entries/:id', (ctx) => asAdmin(ctx, (actor) => deleteEntry(actor, ctx.params.id)));

    // A statement this server has already (a retry, or a replay after a rollback) is 200 `exists`, not a refusal.
    router.post('/api/names/generations', (ctx) => asAdmin(ctx, (actor, body) => {
        const out = addGeneration(actor, body);
        if (!out.exists) return { id: out.id, n: out.n };
        ctx.status = 200;
        return { id: out.id, n: out.n, code: 'exists' };
    }, 201));
    router.post('/api/names/shares', (ctx) => asAdmin(ctx, (actor, body) => addShare(actor, body)));

    router.post('/api/names/confirmations', (ctx) => asAdmin(ctx, (actor, body) => confirmMember(actor, body), 201));
    router.post('/api/names/confirmations/:id/second', (ctx) => asAdmin(ctx, (actor) => secondConfirmation(actor, ctx.params.id)));
    router.post('/api/names/confirmations/:id/revoke', (ctx) => asAdmin(ctx, (actor) => revokeConfirmation(actor, ctx.params.id)));

    router.get('/api/names/log', (ctx) => asAdmin(ctx, () => {
        const limit = wholeQuery(ctx.query.limit, DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT);
        const offset = wholeQuery(ctx.query.offset, 0, 1_000_000);
        if (limit === null || limit < 1) throw new NamesListError(400, 'bad_request', `limit must be a whole number from 1 to ${MAX_LOG_LIMIT}.`);
        if (offset === null) throw new NamesListError(400, 'bad_request', 'offset must be a whole number.');
        return { ...readNamesLog(limit, offset), limit, offset };
    }));

    router.post('/api/names/settings', (ctx) => asAdmin(ctx, (actor, body) => setNamesSettings(actor, body)));

    return router;
}
