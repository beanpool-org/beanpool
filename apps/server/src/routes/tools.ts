/**
 * The tool store's routes (engine/tool-state.ts; slice S2 of scratch/tools/DESIGN-shops-and-tools-fable.md §9.3): each
 * tool's private copy of its owner's document, read and written only by its owner.
 *
 *   GET    /api/tools/:tool                       → { tool, doc, updatedAt, deletedAt, bytes, max }; doc and updatedAt null when none is kept
 *   PUT    /api/tools/:tool  { doc, turnOn? }     → { success: true, tool, updatedAt, bytes, max }
 *                                                   or 410 { error, code: 'tool_copy_off', deletedAt } (below)
 *   DELETE /api/tools/:tool                       → { success: true, tool, removed }
 *
 * and the same for an enterprise's tools, by a keeper of it, with the enterprise as the owner:
 *
 *   GET | PUT | DELETE /api/treasury/:treasury/tools/:tool
 *
 * ## Off means gone
 *
 * scratch/tools/DESIGN-t04-late-put-fable.md §1 (S2.2). A PUT is the member's switch-on when its body says
 * `turnOn: true`, the boolean true and nothing else; any other value, or none, makes it ordinary. An ordinary PUT never
 * writes over a copy its owner removed: with no copy kept and a removal, it answers 410 `tool_copy_off` with the
 * removal's `deletedAt` and writes nothing, so a phone's upload let go before the member switched the copy off (on
 * this phone or another) can't put it back. The switch-on writes, as any PUT did before. A DELETE with no copy kept
 * still leaves a removal (`removed: false`). The flag is in the body, so inside the signature: only the owner's key sets
 * it, and all it lets them do is keep their own copy, which is what switching on is.
 *
 * ## Only ever the owner's own
 *
 * No route takes the owner from the query or the body: a member is `ctx.state.actor`, verified by the real
 * `requireSignature` middleware, and an enterprise is the path's, which the signer must keep (canOperateTreasury, as for
 * its Offers). The body carries the document under `doc` and the switch-on flag beside it, and nothing else is read,
 * so nothing in it can name anyone: the middleware's spoof check reads the body's top level, and the document is never
 * read for an identity. The read is a gated read (unsigned 401, and a key that is no member here 403 from the
 * middleware); the checks here answer the same where the middleware lets a request through (a node with
 * ENFORCE_READ_AUTH=false, and a write, which it does not hold to membership). A closed account's key, a replaced one
 * and a visitor's row are refused by the middleware before any of this. A suspended member keeps and changes their own
 * copies; a keeper must be active to touch an enterprise's.
 *
 * Every answer is private and no-store. Nothing goes to anyone's socket and nothing to the activity feed.
 *
 * ## The main server only, for a change
 *
 * A standby answers the read from its copy and refuses a change, 409 `standby`, before the handler runs
 * (routes/standby-ledger-gate.ts), and the engine refuses underneath. Each change is one of the signer's day of signed
 * writes, or the enterprise's when a keeper writes for it (the gateway's day budget).
 */
import Router from '@koa/router';
import { passesReadGate, isNodeMember, canOperateTreasury } from '../state-engine.js';
import { db } from '../db/db.js';
import { StandbyLedgerError } from '../config/node-role.js';
import { NOT_A_MEMBER_CODE, NOT_A_MEMBER_ERROR } from '../engine/members.js';
import {
    readToolState, writeToolState, deleteToolState, toolStateDeletedAt, toolIdRefusal, ToolStateRefusal, TOOL_STATE_MAX_BYTES,
} from '../engine/tool-state.js';
import type Koa from 'koa';
import type { RouteDeps } from './types.js';
import { word } from '@beanpool/core';

type Op = 'read' | 'write';
/** A request as the router hands it over, with the body the JSON middleware parsed (https-server.ts). */
type Ctx = Koa.Context & { params: Record<string, string | undefined>; requestBody?: { doc?: unknown; turnOn?: unknown } };

function refuse(ctx: Ctx, status: number, error: string, code?: string, extra: Record<string, unknown> = {}): void {
    ctx.set('Cache-Control', 'private, no-store');
    ctx.status = status;
    ctx.body = code ? { error, code, ...extra } : { error };
}

/** The verified signer, or undefined once the refusal is written. */
function signer(ctx: Ctx): string | undefined {
    const actor = ctx.state.actor as string | undefined;
    if (!actor) refuse(ctx, 401, word('A signed request is required'));
    return actor;
}

/** The member whose own copies these are, or undefined once the refusal is written. */
function ownOwner(ctx: Ctx, op: Op): string | undefined {
    const actor = signer(ctx);
    if (!actor) return undefined;
    if (op === 'read' ? !passesReadGate(actor) : !isNodeMember(actor)) {
        if (op === 'read') refuse(ctx, 403, word('Read access requires a member identity'));
        else refuse(ctx, 403, NOT_A_MEMBER_ERROR, NOT_A_MEMBER_CODE);
        return undefined;
    }
    return actor;
}

/**
 * The enterprise whose copies these are, when the signer keeps it, or undefined once the refusal is written. Its order
 * and words are its Offers' (routes/treasury.ts requireOperator): no such enterprise 404, someone who doesn't keep it
 * 403. One closed (pruned, disabled, suspended) has no tools to read or change; one wound up keeps its copies to read.
 */
function enterpriseOwner(ctx: Ctx, op: Op): string | undefined {
    const actor = signer(ctx);
    if (!actor) return undefined;
    const treasury = String(ctx.params.treasury ?? '');
    const row = db.prepare('SELECT status FROM members WHERE public_key = ? AND is_treasury = 1').get(treasury) as { status: string | null } | undefined;
    if (!row) { refuse(ctx, 404, word('Not a treasury')); return undefined; }
    if (!canOperateTreasury(actor, treasury)) { refuse(ctx, 403, word('You are not a keeper of this enterprise')); return undefined; }
    if (row.status === 'pruned' || row.status === 'disabled' || row.status === 'suspended') {
        refuse(ctx, 403, word('This enterprise has been closed, so its tools can no longer be read or changed.'), 'enterprise_closed');
        return undefined;
    }
    if (op === 'write' && row.status === 'completed') {
        refuse(ctx, 403, word('This enterprise has been wound up, so its tools can no longer be changed.'), 'enterprise_closed');
        return undefined;
    }
    return treasury;
}

/** The path's tool, or undefined once the refusal is written. */
function toolOf(ctx: Ctx): string | undefined {
    const tool = ctx.params.tool;
    const refusal = toolIdRefusal(tool);
    if (refusal) { refuse(ctx, refusal.status, refusal.message, refusal.code); return undefined; }
    return tool;
}

/** An engine refusal answered in its words, or false for anything else (rethrown by the caller). */
function answeredRefusal(ctx: Ctx, e: unknown): boolean {
    if (e instanceof ToolStateRefusal) { refuse(ctx, e.status, e.message, e.code, e.extra); return true; }
    if (e instanceof StandbyLedgerError) { refuse(ctx, e.status, e.message, e.code); return true; }
    return false;
}

function answer(ctx: Ctx, body: Record<string, unknown>): void {
    ctx.set('Cache-Control', 'private, no-store');
    ctx.body = body;
}

/** The three handlers for one kind of owner: the member's own, or an enterprise's. */
function handlers(ownerOf: (ctx: Ctx, op: Op) => string | undefined) {
    return {
        get: async (ctx: Ctx) => {
            const owner = ownerOf(ctx, 'read');
            const tool = owner && toolOf(ctx);
            if (!owner || !tool) return;
            const state = readToolState(owner, tool);
            const deletedAt = state ? null : toolStateDeletedAt(owner, tool);
            answer(ctx, {
                tool,
                doc: state?.doc ?? null,
                updatedAt: state?.updatedAt ?? null,
                deletedAt,
                bytes: state?.bytes ?? 0,
                max: TOOL_STATE_MAX_BYTES,
            });
        },
        put: async (ctx: Ctx) => {
            const owner = ownerOf(ctx, 'write');
            const tool = owner && toolOf(ctx);
            if (!owner || !tool) return;
            try {
                const state = writeToolState(owner, tool, ctx.requestBody?.doc, { turnOn: ctx.requestBody?.turnOn === true });
                answer(ctx, { success: true, tool, updatedAt: state.updatedAt, bytes: state.bytes, max: TOOL_STATE_MAX_BYTES });
            } catch (e) {
                if (!answeredRefusal(ctx, e)) throw e;
            }
        },
        delete: async (ctx: Ctx) => {
            const owner = ownerOf(ctx, 'write');
            const tool = owner && toolOf(ctx);
            if (!owner || !tool) return;
            try {
                answer(ctx, { success: true, tool, removed: deleteToolState(owner, tool) });
            } catch (e) {
                if (!answeredRefusal(ctx, e)) throw e;
            }
        },
    };
}

export function createToolRoutes(_deps: RouteDeps): Router {
    const router = new Router();
    const own = handlers(ownOwner);
    router.get('/api/tools/:tool', own.get);
    router.put('/api/tools/:tool', own.put);
    router.delete('/api/tools/:tool', own.delete);
    const enterprise = handlers(enterpriseOwner);
    router.get('/api/treasury/:treasury/tools/:tool', enterprise.get);
    router.put('/api/treasury/:treasury/tools/:tool', enterprise.put);
    router.delete('/api/treasury/:treasury/tools/:tool', enterprise.delete);
    return router;
}
