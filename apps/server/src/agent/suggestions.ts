/**
 * An AI assistant's suggestions (admin MCP design §5, slice S4). An assistant changes nothing in moderation: it files a
 * suggestion, and the member it acts for approves or declines it in Settings → Moderation or on their phone, with the
 * ORIGINAL report beside it, never the assistant's summary alone.
 *
 * - A suggestion is a row {grant, kind, target, reason (≤ 2 KB, member text: fenced wherever it is shown), at, expires 48 h},
 *   kept in node_config `agent_suggestions` (this server's own, never copied to a standby).
 * - Limits per grant: at most 10 open, 30 filed a day (UTC), one per target (a report), and none about a report whose
 *   suggestion was declined in the last 48 h. All of a grant's go when it is revoked, and none is shown or approvable once
 *   the grant has expired or its member is no longer an owner or admin, nor while the owners' switch is off (they wait,
 *   hidden, and come back if it is turned on again before they expire).
 * - A dismiss or remove suggestion can't be approved once its report is closed (dismissed or actioned since).
 * - Approve runs the EXISTING route (reports/:id/dismiss, reports/:id/action, posts/:id/restore) under the human's own
 *   session, so the moderator rules and any step-up there are unchanged: the card sends `suggestion: <id>` with that
 *   route's own call (`approveCall`), the route checks the suggestion matches (`admitSuggestion`) before it acts, and on
 *   success writes its audit line with "from a suggestion by agent <name>" (`settleSuggestion`). Only the member the
 *   assistant acts for approves; they or an owner decline (it is deleted).
 * - No token reaches any of it: the routes take a person's session (automation-tokens.ts refuses every token off /mcp),
 *   and /mcp has no tool that approves.
 */
import crypto from 'node:crypto';
import { db } from '../db/db.js';
import { listAutomationTokens } from '../automation-tokens.js';
import { listOAuthGrants } from './oauth.js';
import { getLocalConfig } from '../config/local-config.js';
import { nodeRoleOf } from '../engine/node-roles.js';
import { logger } from '../logger.js';
import { cleanMemberText } from './fence.js';

export const SUGGESTION_KINDS = ['dismiss_report', 'remove_reported', 'restore_post'] as const;
export type SuggestionKind = typeof SUGGESTION_KINDS[number];

export const SUGGESTIONS_OPEN_MAX = 10;
export const SUGGESTIONS_PER_DAY = 30;
export const SUGGESTION_TTL_MS = 48 * 60 * 60_000;
export const SUGGESTION_REASON_MAX_BYTES = 2048;

const KEY = 'agent_suggestions';

/** What each kind asks for, in the words a card shows. */
export const SUGGESTION_WORDS: Record<SuggestionKind, string> = {
    dismiss_report: 'Dismiss this report (keep the post)',
    remove_reported: 'Remove what was reported',
    restore_post: 'Restore the post hidden by reports',
};

export interface Suggestion {
    id: string;
    grantId: string;
    kind: SuggestionKind;
    /** A report id: every kind is about one report. */
    target: string;
    /** The assistant's words, cleaned and capped; member-written in effect, so fenced or escaped wherever shown. */
    reason: string;
    at: number;
    expiresAt: number;
}

interface Stored {
    open: Suggestion[];
    /** Filed per grant per UTC day: a declined or approved one still counts. */
    filed: Record<string, { day: string; n: number }>;
    /** Today's approvals, node-wide, for the owners' daily line. */
    approved: { day: string; n: number };
    /** Today's suggestions filed, node-wide. */
    filedToday: { day: string; n: number };
    /** Declined (grant, report) pairs: that assistant files nothing more about that report until `until` (48 h). */
    declined: Array<{ grantId: string; target: string; until: number }>;
}

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

function read(): Stored {
    const empty: Stored = { open: [], filed: {}, approved: { day: '', n: 0 }, filedToday: { day: '', n: 0 }, declined: [] };
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(KEY) as { value: string } | undefined;
    if (!row) return empty;
    try {
        const s = JSON.parse(row.value);
        return {
            open: Array.isArray(s?.open) ? s.open.filter((x: Suggestion | null) =>
                typeof x?.id === 'string' && typeof x.grantId === 'string' && SUGGESTION_KINDS.includes(x.kind as SuggestionKind)
                && typeof x.target === 'string' && typeof x.expiresAt === 'number') : [],
            filed: s?.filed && typeof s.filed === 'object' ? s.filed : {},
            approved: s?.approved && typeof s.approved.n === 'number' ? s.approved : empty.approved,
            filedToday: s?.filedToday && typeof s.filedToday.n === 'number' ? s.filedToday : empty.filedToday,
            declined: Array.isArray(s?.declined) ? s.declined.filter((d: { grantId?: unknown; target?: unknown; until?: unknown } | null) =>
                typeof d?.grantId === 'string' && typeof d.target === 'string' && typeof d.until === 'number') : [],
        };
    } catch {
        return empty;
    }
}

function write(s: Stored, now: number): void {
    const day = utcDay(now);
    for (const [g, f] of Object.entries(s.filed)) if (f.day !== day) delete s.filed[g];
    s.declined = s.declined.filter((d) => d.until > now);
    db.prepare('INSERT OR REPLACE INTO node_config (key, value) VALUES (?, ?)').run(KEY, JSON.stringify(s));
}

export interface LiveGrant { id: string; name: string; member: string; role: 'owner' | 'admin' }

/** A grant that can still act: an agent token not expired, or an OAuth grant not idle 30 days; its member an owner or admin now. */
export function grantStillLive(grantId: string, now = Date.now()): LiveGrant | null {
    const o = listOAuthGrants(now).find((x) => x.id === grantId);
    if (o) {
        const r = nodeRoleOf(o.member);
        return r === 'owner' || r === 'admin' ? { id: o.id, name: cleanMemberText(o.clientName, 60) || 'AI assistant', member: o.member, role: r } : null;
    }
    const t = listAutomationTokens().find((x) => x.id === grantId && x.scope === 'agent');
    if (!t || (typeof t.expiresAt === 'number' && t.expiresAt <= now) || typeof t.createdBy !== 'string') return null;
    const role = nodeRoleOf(t.createdBy);
    if (role !== 'owner' && role !== 'admin') return null;
    return { id: t.id, name: cleanMemberText(t.name, 60), member: t.createdBy, role };
}

/** The owners' switch "Allow AI assistants" (agent/mcp-route.ts aiAssistantsAllowed, read here to keep the imports one way). */
const assistantsAllowed = (): boolean => getLocalConfig().aiAssistantsAllowed !== false;

/** The open suggestions whose grant is live, the expired ones dropped; none while the owners' switch is off. */
export function openSuggestions(now = Date.now()): Array<Suggestion & { grant: LiveGrant }> {
    const s = read();
    const kept = s.open.filter((x) => x.expiresAt > now);
    if (kept.length !== s.open.length) { s.open = kept; write(s, now); }
    if (!assistantsAllowed()) return [];
    const out: Array<Suggestion & { grant: LiveGrant }> = [];
    for (const x of kept) {
        const grant = grantStillLive(x.grantId, now);
        if (grant) out.push({ ...x, grant });
    }
    return out;
}

/** How many wait for this member (or, with no member, for anyone): the phone's badge count, counts only. */
export function suggestionCountFor(member: string | null, now = Date.now()): number {
    return openSuggestions(now).filter((x) => member === null || x.grant.member.toLowerCase() === member.toLowerCase()).length;
}

/** The reason as stored: control and bidi characters stripped, markers defused, at most 2 KB of UTF-8. */
export function cleanReason(value: unknown): string {
    let s = cleanMemberText(value, SUGGESTION_REASON_MAX_BYTES);
    while (Buffer.byteLength(s, 'utf8') > SUGGESTION_REASON_MAX_BYTES) s = Array.from(s).slice(0, -1).join('');
    return s;
}

export type FileResult = { ok: true; suggestion: Suggestion } | { ok: false; error: string };

/** File one suggestion for a grant, inside its limits. The target is checked by the caller (the report exists). */
export function fileSuggestion(grantId: string, kind: SuggestionKind, target: string, reason: unknown, now = Date.now()): FileResult {
    const s = read();
    s.open = s.open.filter((x) => x.expiresAt > now);
    const mine = s.open.filter((x) => x.grantId === grantId);
    if (mine.some((x) => x.target === target)) {
        return { ok: false, error: 'This assistant already has a suggestion waiting for that report: one per report.' };
    }
    if (s.declined.some((d) => d.grantId === grantId && d.target === target && d.until > now)) {
        return { ok: false, error: 'Your suggestion about that report was declined: suggest nothing more about it for 48 hours.' };
    }
    if (mine.length >= SUGGESTIONS_OPEN_MAX) {
        return { ok: false, error: `This assistant has ${SUGGESTIONS_OPEN_MAX} suggestions waiting, the most it may: wait until they are approved or declined.` };
    }
    const day = utcDay(now);
    const f = s.filed[grantId]?.day === day ? s.filed[grantId] : { day, n: 0 };
    if (f.n >= SUGGESTIONS_PER_DAY) {
        return { ok: false, error: `This assistant has made ${SUGGESTIONS_PER_DAY} suggestions today, the most a day allows: try again tomorrow (UTC).` };
    }
    const text = cleanReason(reason);
    if (!text) return { ok: false, error: 'A suggestion needs a reason the admin can read.' };
    const suggestion: Suggestion = {
        id: crypto.randomBytes(8).toString('hex'), grantId, kind, target, reason: text, at: now, expiresAt: now + SUGGESTION_TTL_MS,
    };
    s.open.push(suggestion);
    s.filed[grantId] = { day, n: f.n + 1 };
    s.filedToday = s.filedToday.day === day ? { day, n: s.filedToday.n + 1 } : { day, n: 1 };
    write(s, now);
    return { ok: true, suggestion };
}

function remove(id: string, now: number, approved: boolean): Suggestion | null {
    const s = read();
    const hit = s.open.find((x) => x.id === id) ?? null;
    if (!hit) return null;
    s.open = s.open.filter((x) => x.id !== id);
    if (approved) {
        const day = utcDay(now);
        s.approved = s.approved.day === day ? { day, n: s.approved.n + 1 } : { day, n: 1 };
    } else {
        s.declined.push({ grantId: hit.grantId, target: hit.target, until: now + SUGGESTION_TTL_MS });
    }
    write(s, now);
    return hit;
}

/** Decline: the suggestion is deleted, and its assistant files nothing more about that report for 48 hours. */
export function declineSuggestion(id: string, now = Date.now()): Suggestion | null {
    return remove(id, now, false);
}

/** Every suggestion of a grant goes when it is revoked (both revoke routes call this: grants-route.ts, routes/automation-tokens.ts). */
export function dropSuggestionsOf(grantId: string, now = Date.now()): number {
    const s = read();
    const before = s.open.length;
    s.open = s.open.filter((x) => x.grantId !== grantId);
    if (s.open.length !== before) write(s, now);
    return before - s.open.length;
}

/** Today's counts for the owners' daily line (counts only). */
export function suggestionCountsToday(now = Date.now()): { suggestions: number; approved: number } {
    const s = read();
    const day = utcDay(now);
    return { suggestions: s.filedToday.day === day ? s.filedToday.n : 0, approved: s.approved.day === day ? s.approved.n : 0 };
}

/** The report's subject and whether it is still open, for a card's approve call and the route's checks. */
function reportTarget(reportId: string): { postId: string | null; pulse: boolean; open: boolean } | null {
    const r = db.prepare('SELECT target_post_id, target_pulse_item_id, status FROM abuse_reports WHERE id = ?').get(reportId) as
        { target_post_id: string | null; target_pulse_item_id: string | null; status: string | null } | undefined;
    if (!r) return null;
    return { postId: r.target_pulse_item_id ? null : r.target_post_id, pulse: !!r.target_pulse_item_id, open: r.status === 'pending' || r.status === null };
}

/** A dismiss or remove suggestion is about an open report: once it is closed there is nothing left to approve. */
const closedSince = (x: Pick<Suggestion, 'kind'>, t: { open: boolean } | null): boolean => x.kind !== 'restore_post' && !!t && !t.open;

/** The existing route's own call that approves it: the card sends exactly this, with `suggestion` in the body. */
export function approveCall(x: Suggestion): { method: 'POST'; path: string; body: Record<string, unknown> } | null {
    const t = reportTarget(x.target);
    if (!t || closedSince(x, t)) return null;
    const rid = encodeURIComponent(x.target);
    if (x.kind === 'dismiss_report') return { method: 'POST', path: `/api/local/admin/reports/${rid}/dismiss`, body: { suggestion: x.id } };
    if (x.kind === 'remove_reported') {
        if (!t.pulse && !t.postId) return null;
        return {
            method: 'POST', path: `/api/local/admin/reports/${rid}/action`,
            body: t.pulse ? { removePulseItem: true, suggestion: x.id } : { deletePost: true, suggestion: x.id },
        };
    }
    if (!t.postId) return null;
    return { method: 'POST', path: `/api/local/admin/posts/${encodeURIComponent(t.postId)}/restore`, body: { suggestion: x.id } };
}

/** Which existing route is asking, and its target. */
export type SuggestionRoute =
    | { kind: 'dismiss_report'; reportId: string }
    | { kind: 'remove_reported'; reportId: string; body: Record<string, unknown> }
    | { kind: 'restore_post'; postId: string };

const SUGGESTION_GONE = 'That suggestion is no longer waiting (approved, declined, expired, or its assistant disconnected).';
const SUGGESTIONS_OFF = "AI assistants are turned off on this node: their suggestions wait, hidden, until an owner turns them back on.";

/**
 * Called by the existing route, after its own sign-in check and before it acts, when its body names a `suggestion`.
 * Answers true (go on) when there is none, or when it is open, live, of this route's kind and target, and the session is
 * the member the assistant acts for, signed in with their key. Otherwise answers 403 or 409 and false: the route does
 * nothing. A suggestion never suspends a member.
 */
export function admitSuggestion(ctx: any, route: SuggestionRoute, now = Date.now()): boolean {
    const b = ctx.requestBody ?? ctx.request?.body;
    const id = b && typeof b === 'object' ? (b as Record<string, unknown>).suggestion : undefined;
    if (id === undefined || id === null) return true;
    const refuse = (status: number, error: string) => { ctx.status = status; ctx.body = { success: false, error }; return false; };
    if (typeof id !== 'string' || !id) return refuse(400, 'suggestion must be the id of a waiting suggestion');
    if (!assistantsAllowed()) return refuse(409, SUGGESTIONS_OFF);
    const hit = openSuggestions(now).find((x) => x.id === id);
    if (!hit) return refuse(409, SUGGESTION_GONE);
    const actor = ctx.state?.isKeySession === true && typeof ctx.state?.actor === 'string' ? ctx.state.actor : null;
    if (!actor || actor.toLowerCase() !== hit.grant.member.toLowerCase()) {
        return refuse(403, 'Only the member this assistant acts for can approve its suggestion, signed in with their own key.');
    }
    let matches = hit.kind === route.kind;
    if (matches && route.kind === 'dismiss_report') matches = route.reportId === hit.target;
    if (matches && route.kind === 'remove_reported') {
        const t = reportTarget(hit.target);
        matches = route.reportId === hit.target && !route.body.suspendUser
            && (t?.pulse ? route.body.removePulseItem === true && !route.body.deletePost : route.body.deletePost === true && !route.body.removePulseItem);
    }
    if (matches && route.kind === 'restore_post') matches = reportTarget(hit.target)?.postId === route.postId;
    if (!matches) return refuse(409, 'That suggestion is for another action or another report.');
    if (closedSince(hit, reportTarget(hit.target))) return refuse(409, 'That report was closed since the assistant suggested this: there is nothing left to approve.');
    ctx.state.agentSuggestion = { id: hit.id, agent: hit.grant.name, kind: hit.kind, target: hit.target };
    return true;
}

/** The audit line's words when the route acted on a suggestion; empty otherwise. */
export function suggestionAuditSuffix(ctx: any): string {
    const s = ctx.state?.agentSuggestion as { agent: string } | undefined;
    return s ? `, from a suggestion by agent "${s.agent}"` : '';
}

/**
 * After the existing route succeeded: the suggestion is approved (gone), and the audit line says whose it was. `line` is
 * the route's own words for what it did; routes that already log pass `logged: true` and add the suffix themselves.
 */
export function settleSuggestion(ctx: any, line: string, opts: { logged?: boolean } = {}, now = Date.now()): void {
    const s = ctx.state?.agentSuggestion as { id: string } | undefined;
    if (!s || (ctx.status && ctx.status >= 300)) return;
    remove(s.id, now, true);
    if (!opts.logged) {
        const by = typeof ctx.state?.actor === 'string' ? ctx.state.actor.substring(0, 12) : 'owner:password';
        logger.info('ADMIN', `${line} by ${by} (${ctx.state?.adminRole})${suggestionAuditSuffix(ctx)}`);
    }
}

/** For tests. */
export function resetSuggestions(): void {
    db.prepare('DELETE FROM node_config WHERE key = ?').run(KEY);
}
