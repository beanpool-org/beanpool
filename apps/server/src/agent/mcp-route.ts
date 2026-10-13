/**
 * The AI assistant endpoint (admin MCP design §1, §2; slice S1): `POST /mcp`, the Model Context Protocol over the
 * official TypeScript SDK's Streamable HTTP transport, stateless, answering JSON. The admin brings their own assistant;
 * nothing here calls a model.
 *
 * The boundary is this server, never the assistant's process. In order, every request to /mcp:
 *   1. the owner switch "Allow AI assistants" (local config `aiAssistantsAllowed`, on unless an owner turned it off): off → 404;
 *   2. `Origin` absent or this node's own public address, else 403 (a web page cannot drive it from a browser);
 *   3. POST only: GET (no server push in v1), DELETE and the rest → 405;
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

const UNAUTHORISED = "Send an AI assistant's token as `Authorization: Bearer bp_…`: an owner makes one in Settings";

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
function nodeUrlFor(ctx: any): string {
    const pub = resolvePublicNodeUrl();
    if (pub) return pub.replace(/\/+$/, '');
    const host = String(ctx.host || '');
    return /^[a-z0-9.\-:[\]]{1,255}$/i.test(host) ? `https://${host}` : 'this server';
}

type GrantCheck = { ok: true; grant: AgentGrant } | { ok: false; status: number; error: string };

/** The agent grant behind a request's bearer, its maker's role read now. */
export function agentGrantFrom(ctx: any): GrantCheck {
    const header = String(ctx.get?.('authorization') || '');
    const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (!m || !looksLikeAutomationToken(m[1])) return { ok: false, status: 401, error: UNAUTHORISED };
    const record = verifyAutomationToken(m[1]);
    if (!record) return { ok: false, status: 401, error: 'Invalid, revoked or expired token' };
    if (record.scope !== 'agent') {
        return { ok: false, status: 403, error: "Only an AI assistant's token (the agent scope) reaches /mcp: this token's scope is another" };
    }
    const role = typeof record.createdBy === 'string' ? nodeRoleOf(record.createdBy) : null;
    if (role !== 'owner' && role !== 'admin') {
        logger.warn('AGENT', 'Assistant refused: its member is no longer an owner or admin', { grant: record.id });
        return { ok: false, status: 401, error: 'Invalid, revoked or expired token' };
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
                ? { title: t.title, readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false }
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

    router.all(MCP_PATH, async (ctx) => {
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
            logger.warn('AGENT', 'Assistant endpoint refused a request', { status: check.status, from: logAddressTag(clientLimiterKey(ctx)) });
            jsonRpcError(ctx, check.status, check.error);
            return;
        }
        const grant = check.grant;
        // 5. The grant's limits.
        const admitted = admitAgentCall(grant.id);
        if (!admitted.ok) {
            ctx.set('Retry-After', String(admitted.retryAfterSeconds));
            logger.warn('AGENT', 'Assistant over its limit', { grant: grant.id });
            jsonRpcError(ctx, 429, admitted.error);
            return;
        }
        noteAutomationTokenUse(grant.id, `POST ${MCP_PATH}`);

        // The body: parsed already for a JSON request (https-server.ts); a body that does not parse is a parse error.
        let parsed: unknown;
        const rawBody: unknown = (ctx as any).rawBody;
        if (typeof rawBody === 'string') {
            try { parsed = JSON.parse(rawBody); } catch {
                jsonRpcError(ctx, 400, 'Parse error: the body is not JSON', -32700);
                return;
            }
        }
        const methods = (Array.isArray(parsed) ? parsed : [parsed])
            .map((m: any) => (m && typeof m.method === 'string' ? m.method : null))
            .filter((m): m is string => !!m && m !== 'tools/call' && m !== 'prompts/get' && !m.startsWith('notifications/'));
        if (methods.length) logger.info('AGENT', 'Assistant request', { grant: grant.id, member: grant.member.slice(0, 16), methods: methods.slice(0, 5) });

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
    });

    // The owner switch. Reading it: any admin. Turning it on or off: an owner (requireAdminRole: never a token, and a
    // phone session asks for its unlock again). Owners are told either way.
    router.get(AGENT_SWITCH_PATH, async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        if (!(await deps.checkAdminAuth(ctx))) return;
        ctx.body = { allowed: aiAssistantsAllowed() };
    });

    router.post(AGENT_SWITCH_PATH, async (ctx) => {
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
