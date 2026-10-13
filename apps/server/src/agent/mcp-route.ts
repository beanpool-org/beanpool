/**
 * The AI assistant endpoint (admin MCP design §1, §2; slice S1): `POST /mcp`, the Model Context Protocol over the
 * official TypeScript SDK's Streamable HTTP transport, stateless, answering JSON. The admin brings their own assistant;
 * nothing here calls a model.
 *
 * The boundary is this server, never the assistant's process. In order, every request to /mcp:
 *   1. the owner switch "Allow AI assistants" (local config `aiAssistantsAllowed`, on unless an owner turned it off): off → 404;
 *   2. `Origin` absent or this node's own public address, else 403 (a web page cannot drive it from a browser);
 *   3. POST only: GET (no server push in v1) and DELETE (no session to end) → 405; no other method is a route here, so the
 *      router answers PUT and PATCH 405 itself and the CORS layer answers OPTIONS 204, switch on or off, before any of this;
 *   4. a bearer that is an automation token of the `agent` scope, and nothing else (no session, cookie, password or other
 *      scope), whose maker is an owner or an admin NOW (lose the role, lose the assistant) → else 401 (403 for another scope);
 *   5. 60 calls a minute and 2,000 a day per token → 429 in words;
 *   6. then the tools (agent/tools.ts), each answer redacted at its source, every tool call written to the AGENT log.
 * An `agent` token reaches nothing but this (admin-auth.ts checkAutomationToken refuses it everywhere else).
 */
import Router from '@koa/router';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
    CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListToolsRequestSchema, McpError, ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import type { RouteDeps } from '../routes/types.js';
import { requireAdminRole } from '../admin-auth.js';
import { looksLikeAutomationToken, noteAutomationTokenUse, verifyAutomationToken } from '../automation-tokens.js';
import { getLocalConfig, updateLocalConfig } from '../config/local-config.js';
import { nodeRoleOf } from '../engine/node-roles.js';
import { directoryName, getMember, resolvePublicNodeUrl } from '../state-engine.js';
import { getVersion } from '../version.js';
import { logger } from '../logger.js';
import { noteSecurityEvent } from '../services/security-signal.js';
import { logAddressTag } from '../log-address.js';
import { clientLimiterKey } from '../client-ip.js';
import { cleanMemberText, newBoundary } from './fence.js';
import { admitAgentCall } from './limits.js';
import { offersSuggestions, toolDescription, toolsFor, type AgentGrant } from './tools.js';
import { PROMPTS, promptText, welcomeInstructions, type WelcomeFacts } from './welcome.js';

export const MCP_PATH = '/mcp';
export const AGENT_SWITCH_PATH = '/api/local/admin/agent/switch';

/** The owner switch: on unless an owner turned it off. */
export function aiAssistantsAllowed(): boolean {
    return getLocalConfig().aiAssistantsAllowed !== false;
}

const UNAUTHORISED = "Send an AI assistant's token as `Authorization: Bearer bp_…`: an owner or an admin makes one in Settings → Connected assistants";

function jsonRpcError(ctx: any, status: number, message: string, code = -32000): void {
    ctx.status = status;
    ctx.set('Cache-Control', 'no-store');
    ctx.body = { jsonrpc: '2.0', error: { code, message }, id: null };
}

/** This node's own origin (its public address), or null when it has none: then only a request with no Origin passes. */
function ownOrigin(): string | null {
    const url = resolvePublicNodeUrl();
    if (!url) return null;
    try { return new URL(url).origin; } catch { return null; }
}

/** The address the welcome names: the public one, else the host the assistant reached (a LAN node). */
export function nodeUrlFor(ctx: any): string {
    const pub = resolvePublicNodeUrl();
    if (pub) return pub.replace(/\/+$/, '');
    const host = String(ctx.host || '');
    return /^[a-z0-9.\-:[\]]{1,255}$/i.test(host) ? `https://${host}` : 'this server';
}

// ── A refused request's line ──
// Every request refused here (401 or 403 at the token, 429 past the limits, 415, a batch) writes a line starting
// "Assistant refused", within a budget node-wide: the first AGENT_REFUSAL_LOG_BUDGET a minute are written one by one, the
// rest counted into one "…and M more" line when the minute is over (claim-code.ts claimLogAdmit's pattern). logger.ts
// pruneSystemLogs keeps those lines apart (AGENT_REFUSED_LOG_KEEP_ROWS), so no number of refusals, from anyone, takes
// the line of a call that was let in (review of #1855: 5,000 tokenless POSTs emptied the assistant's own record).
// The "…and M more" line counts them by status and by grant, so 20 tokenless requests opening a minute cannot hide which
// grant was refused after them, a demoted maker's included (#1855 confirmation 2, finding 1). A grant id there is one a
// token check found (at most TOKEN_LIMIT of them), never what a request sent.

export const AGENT_REFUSAL_LOG_BUDGET = 20;
const REFUSAL_LOG_WINDOW_MS = 60_000;
let refusalWindowStart = 0, refusalWritten = 0, refusalUnwritten = 0;
let refusalSummaryTimer: ReturnType<typeof setTimeout> | null = null;
/** Why a request was refused, as the summary line counts it: the HTTP status, or what the status alone does not say. */
export type RefusalKind = '401' | '403' | '415' | '429' | 'batch' | 'demoted';
const refusalByKind = new Map<RefusalKind, number>();
const refusalByGrant = new Map<string, number>();

function writeRefusalSummary(): void {
    if (refusalSummaryTimer) clearTimeout(refusalSummaryTimer);
    refusalSummaryTimer = null;
    if (refusalUnwritten > 0) {
        logger.warn('AGENT', `Assistant refused ${refusalUnwritten} more requests in that minute, past the ${AGENT_REFUSAL_LOG_BUDGET} logged one by one`, {
            byStatus: Object.fromEntries(refusalByKind), grants: Object.fromEntries(refusalByGrant),
        });
    }
    refusalUnwritten = 0;
    refusalByKind.clear();
    refusalByGrant.clear();
}

/**
 * Write a refused request's line (`message` starts "Assistant refused") within the minute's budget, else count it, by
 * `kind` and by the grant a token check found (`metadata.grant`).
 */
function logRefusal(message: string, metadata: Record<string, unknown>, kind: RefusalKind, now = Date.now()): void {
    if (now - refusalWindowStart >= REFUSAL_LOG_WINDOW_MS) {
        writeRefusalSummary();
        refusalWindowStart = now;
        refusalWritten = 0;
    }
    if (refusalWritten < AGENT_REFUSAL_LOG_BUDGET) {
        refusalWritten++;
        logger.warn('AGENT', message, metadata);
        return;
    }
    refusalUnwritten++;
    refusalByKind.set(kind, (refusalByKind.get(kind) ?? 0) + 1);
    if (typeof metadata.grant === 'string') refusalByGrant.set(metadata.grant, (refusalByGrant.get(metadata.grant) ?? 0) + 1);
    if (!refusalSummaryTimer) {
        refusalSummaryTimer = setTimeout(writeRefusalSummary, Math.max(0, refusalWindowStart + REFUSAL_LOG_WINDOW_MS - now));
        refusalSummaryTimer.unref?.();
    }
}

/** For tests: the minute ends now (its "…and M more" line written, if any), and the next refusal starts a new one. */
export function endAgentRefusalLogMinute(): void {
    writeRefusalSummary();
    refusalWindowStart = 0;
    refusalWritten = 0;
}

type GrantCheck = { ok: true; grant: AgentGrant } | { ok: false; status: number; error: string; grantId?: string };

/** The agent grant behind a request's bearer, its maker's role read now. */
export function agentGrantFrom(ctx: any): GrantCheck {
    const header = String(ctx.get?.('authorization') || '');
    const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (!m || !looksLikeAutomationToken(m[1])) return { ok: false, status: 401, error: UNAUTHORISED };
    const record = verifyAutomationToken(m[1]);
    if (!record) return { ok: false, status: 401, error: 'Invalid, revoked or expired token' };
    if (record.scope !== 'agent') {
        return { ok: false, status: 403, error: "Only an AI assistant's token (the agent scope) reaches /mcp: this token's scope is another", grantId: record.id };
    }
    const role = typeof record.createdBy === 'string' ? nodeRoleOf(record.createdBy) : null;
    if (role !== 'owner' && role !== 'admin') {
        // Its member is no longer an owner or admin: the route's line names the grant.
        return { ok: false, status: 401, error: 'Invalid, revoked or expired token', grantId: record.id };
    }
    return {
        ok: true,
        grant: {
            id: record.id, name: record.name, member: record.createdBy, role, via: 'token',
            createdAt: record.createdAt, expiresAt: record.expiresAt,
        },
    };
}

function welcomeFacts(ctx: any, grant: AgentGrant): WelcomeFacts {
    return {
        community: cleanMemberText(directoryName(), 120) || 'this community',
        url: nodeUrlFor(ctx),
        callsign: cleanMemberText(getMember(grant.member)?.callsign ?? '', 60) || `the ${grant.role}`,
        role: grant.role,
        canBackup: grant.role === 'owner',
        canSuggest: offersSuggestions(),
    };
}

/** One MCP server for one request (stateless): the grant's tools and prompts, and the welcome made for it. */
export function buildAgentServer(grant: AgentGrant, facts: WelcomeFacts): Server {
    const server = new Server(
        { name: 'beanpool-node', version: getVersion() },
        { capabilities: { tools: {}, prompts: {} }, instructions: welcomeInstructions(facts) },
    );
    const tools = toolsFor(grant);
    const logBase = { grant: grant.id, grantName: cleanMemberText(grant.name, 60), member: grant.member.slice(0, 16) };

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: tools.map((t) => ({
            name: t.name,
            title: t.title,
            description: toolDescription(t),
            inputSchema: t.inputSchema as any,
            outputSchema: t.outputSchema as any,
            annotations: t.write
                ? { title: t.title, readOnlyHint: false, idempotentHint: t.name === 'take_backup', destructiveHint: false, openWorldHint: false }
                : { title: t.title, readOnlyHint: true, openWorldHint: false },
        })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const started = Date.now();
        const name = req.params.name;
        const raw = req.params.arguments;
        const args: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
        const tool = tools.find((t) => t.name === name);
        const argNames = Object.keys(args).slice(0, 10).map((k) => k.slice(0, 40));
        if (!tool) {
            logger.info('AGENT', 'Assistant asked for a tool it does not have', { ...logBase, tool: String(name).slice(0, 60), args: argNames });
            return { content: [{ type: 'text' as const, text: `There is no tool "${String(name).slice(0, 60)}" for this assistant.` }], isError: true };
        }
        let out;
        try {
            out = tool.run(grant, args, newBoundary());
        } catch (e) {
            logger.warn('AGENT', 'Assistant call failed', { ...logBase, tool: tool.name, args: argNames, ms: Date.now() - started, error: e instanceof Error ? e.name : 'error' });
            return { content: [{ type: 'text' as const, text: 'The server could not answer that now: try again later.' }], isError: true };
        }
        logger.info('AGENT', tool.write ? 'Assistant wrote' : 'Assistant read', {
            ...logBase, tool: tool.name, args: argNames, rows: out.ok ? out.rows : 0, ok: out.ok, ms: Date.now() - started,
        });
        if (!out.ok) return { content: [{ type: 'text' as const, text: out.error }], isError: true };
        return { content: [{ type: 'text' as const, text: JSON.stringify(out.result) }], structuredContent: out.result };
    });

    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
        prompts: PROMPTS.map((p) => ({ name: p.name, description: p.description, arguments: p.arguments })),
    }));

    server.setRequestHandler(GetPromptRequestSchema, async (req) => {
        const p = PROMPTS.find((x) => x.name === req.params.name);
        if (!p) throw new McpError(ErrorCode.InvalidParams, `There is no prompt "${String(req.params.name).slice(0, 60)}"`);
        const args: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.params.arguments ?? {})) if (typeof v === 'string') args[k] = v;
        logger.info('AGENT', 'Assistant read a prompt', { ...logBase, prompt: p.name });
        return {
            description: p.description,
            messages: [{ role: 'user' as const, content: { type: 'text' as const, text: promptText(p, args, facts) } }],
        };
    });

    return server;
}

export function createMcpRoutes(deps: RouteDeps): Router {
    const router = new Router();

    const serveMcp: Router.Middleware = async (ctx) => {
        // 1. The owner switch: off, the endpoint is not there at all.
        if (!aiAssistantsAllowed()) {
            ctx.status = 404;
            ctx.body = 'Not Found';
            return;
        }
        // 2. A browser page from anywhere else never drives it (DNS rebinding, a malicious site).
        const origin = ctx.get('origin');
        if (origin && origin !== ownOrigin()) {
            jsonRpcError(ctx, 403, 'This endpoint does not answer web pages from other sites');
            return;
        }
        // 3. POST only: no server push (GET) and no sessions to end (DELETE) in v1.
        if (ctx.method !== 'POST') {
            ctx.set('Allow', 'POST');
            jsonRpcError(ctx, 405, 'Method not allowed: send MCP requests with POST');
            return;
        }
        // 4. An agent token, its member an owner or admin now.
        const check = agentGrantFrom(ctx);
        if (!check.ok) {
            if (check.status === 401) ctx.set('WWW-Authenticate', 'Bearer realm="beanpool", error="invalid_token"');
            const from = logAddressTag(clientLimiterKey(ctx));
            if (check.status === 401 && check.grantId) logRefusal('Assistant refused: its member is no longer an owner or admin', { grant: check.grantId, from }, 'demoted');
            else logRefusal('Assistant refused a request', { status: check.status, from, ...(check.grantId ? { grant: check.grantId } : {}) }, check.status === 403 ? '403' : '401');
            jsonRpcError(ctx, check.status, check.error);
            return;
        }
        const grant = check.grant;
        // 5. The grant's limits.
        const admitted = admitAgentCall(grant.id);
        if (!admitted.ok) {
            ctx.set('Retry-After', String(admitted.retryAfterSeconds));
            logRefusal('Assistant refused: over its limit', { grant: grant.id }, '429');
            jsonRpcError(ctx, 429, admitted.error);
            return;
        }
        noteAutomationTokenUse(grant.id, `POST ${MCP_PATH}`);

        // The body: read, capped and parsed already for a JSON request (https-server.ts); one that does not parse is a
        // parse error. Only a body that parser read goes on: one it did not take as JSON (a Content-Type spelled in
        // capitals, or none) would be read by the SDK itself, past the 64 KiB cap and the one-message rule below.
        const rawBody: unknown = (ctx as any).rawBody;
        if (typeof rawBody !== 'string') {
            logRefusal('Assistant refused: a body the server did not read', { grant: grant.id }, '415');
            jsonRpcError(ctx, 415, 'Send the MCP message with Content-Type: application/json', -32600);
            return;
        }
        let parsed: unknown;
        try { parsed = JSON.parse(rawBody); } catch {
            jsonRpcError(ctx, 400, 'Parse error: the body is not JSON', -32700);
            return;
        }
        // One message per request: a JSON-RPC batch would carry hundreds of calls past the per-call limits (MCP dropped
        // batching in 2025-06-18; the SDK's client never sends one).
        if (Array.isArray(parsed)) {
            logRefusal('Assistant refused: a batch', { grant: grant.id, messages: parsed.length }, 'batch');
            jsonRpcError(ctx, 400, 'Send one MCP message per request: batches are not accepted', -32600);
            return;
        }
        const method = parsed && typeof (parsed as any).method === 'string' ? String((parsed as any).method).slice(0, 60) : null;
        if (method && method !== 'tools/call' && method !== 'prompts/get' && !method.startsWith('notifications/')) {
            logger.info('AGENT', 'Assistant request', { grant: grant.id, member: grant.member.slice(0, 16), method });
        }

        // 6. One server and transport for this request: stateless, JSON answers.
        const server = buildAgentServer(grant, welcomeFacts(ctx, grant));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        ctx.respond = false;
        ctx.res.on('close', () => { void transport.close(); void server.close(); });
        try {
            await server.connect(transport);
            await transport.handleRequest(ctx.req as any, ctx.res, parsed);
        } catch (e) {
            logger.warn('AGENT', 'Assistant endpoint failed a request', { grant: grant.id, error: e instanceof Error ? e.name : 'error' });
            if (!ctx.res.headersSent) {
                ctx.res.statusCode = 500;
                ctx.res.setHeader('Content-Type', 'application/json');
                ctx.res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
            }
        }
    };
    // The methods Streamable HTTP names, each by name (never router.all, which registers ACL, CONNECT and every other verb
    // as a route of its own): POST carries every message; GET (server push) and DELETE (ending a session) answer 405 above.
    router.post(MCP_PATH, serveMcp);
    router.get(MCP_PATH, serveMcp);
    router.delete(MCP_PATH, serveMcp);

    // The owner switch. Reading it: any admin. Turning it on or off: an owner (requireAdminRole: never a token, and a
    // phone session asks for its unlock again). Owners are told either way.
    router.get('/api/local/admin/agent/switch', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        if (!(await deps.checkAdminAuth(ctx))) return;
        ctx.body = { allowed: aiAssistantsAllowed() };
    });

    router.post('/api/local/admin/agent/switch', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        if (!(await deps.checkAdminAuth(ctx))) return;
        if (!requireAdminRole(ctx, ['owner'], 'Only an owner can allow or stop AI assistants on this server')) return;
        const b = (ctx as any).requestBody ?? (ctx.request as any)?.body;
        const allowed = b && typeof b === 'object' ? b.allowed : undefined;
        if (typeof allowed !== 'boolean') {
            ctx.status = 400;
            ctx.body = { error: 'Send { "allowed": true } or { "allowed": false }' };
            return;
        }
        const was = aiAssistantsAllowed();
        if (was !== allowed) {
            updateLocalConfig({ aiAssistantsAllowed: allowed });
            const actor = typeof (ctx.state as any)?.actor === 'string' ? (ctx.state as any).actor : 'owner:password';
            logger.info('ADMIN', allowed ? 'AI assistants allowed' : 'AI assistants turned off', { by: String(actor).slice(0, 16) });
            noteSecurityEvent({
                key: 'sec.agent',
                detail: allowed
                    ? 'AI assistants were allowed on this server by an owner: an assistant with a token an owner made can reach /mcp.'
                    : 'AI assistants were turned off on this server by an owner: /mcp answers to nobody.',
                actor, actorRole: 'owner',
            });
        }
        ctx.body = { allowed };
    });

    return router;
}
