/**
 * An owner's assistant takes posts down (scratch/fable-design/DESIGN-mcp-moderation-fable.md §3.2; slice S1): `take_down`, one post
 * or the post a report is about, and `take_down_many`, by ids or reports. Only a grant ticked "May take down posts for me", off by
 * default, on a server that is still this community's; what a takedown is lives in engine/agent-takedowns.ts.
 *
 * - It moves no Bean. `kept` says what stayed up and why, each in words, never dropped silently: a deal in escrow, a role-holder's
 *   post, a Pulse item (no hidden state: the Settings path), a report about a member or a message, a report already closed.
 * - `reason` is a closed list, the words the author reads. `why` is the assistant's own, cleaned here, and reaches Settings only:
 *   never an author or a reporter, and never a log line.
 * - An id a member chose is words (agent/fence.ts isMadeId), and a report's post id is a stranger's: so it comes back fenced.
 * - There is no tool to put a post back, dismiss a report or lift a mute, however it asks.
 */
import { db } from '../db/db.js';
import { getNodeRole } from '../config/node-role.js';
import { takeDownPosts } from '../state-engine.js';
import { getReplacedInfo } from '../services/identity-epoch.js';
import { TAKEDOWN, takedownsTodayBy } from '../engine/agent-takedowns.js';
import { normaliseRemovalReason, REMOVAL_REASON_LABELS } from '../engine/moderation-notices.js';
import { cleanMemberText, fence, isMadeId, MEMBER_TEXT_NOTICE, type Fenced } from './fence.js';
import { agentPostsPerDay } from './limits.js';
import type { AgentGrant, AgentTool, ToolResult } from './tools.js';

const REASONS = Object.keys(REMOVAL_REASON_LABELS);
const NOT_TICKED = 'This assistant was connected without "May take down posts for me": it takes nothing down. An owner connects one with that tick.';

/** Today's count against the owners' limit, for connection_info. */
export function takedownsSummary(grant: AgentGrant): { today: number; perDay: number } {
    return { today: takedownsTodayBy(grant.id), perDay: agentPostsPerDay() };
}

function gate(grant: AgentGrant): string | null {
    if (grant.role !== 'owner') return "Only an owner's assistant takes posts down: an admin's cannot.";
    if (!grant.canModerate) return NOT_TICKED;
    if (getNodeRole() === 'backup') return 'This server is a standby, which takes no changes: use the main server.';
    const replaced = getReplacedInfo();
    if (replaced) return `${replaced.message} This server takes no changes now; use the one that took over.`;
    return null;
}

const idOf = (v: unknown): string => (typeof v === 'string' ? v.trim().slice(0, 200) : '');

/** An id as it goes back: as it is when this node made it, else fenced, because a member chose it. */
function shown(id: string, boundary: string): string | Fenced | null {
    return isMadeId(id) ? id : fence(boundary, 'a post id a member chose', id);
}

/** The post a report is about, or why there is none to take down. */
function postOfReport(reportId: string): { postId: string } | { why: string } {
    const r = db.prepare('SELECT target_post_id, target_pulse_item_id, target_message_id, status FROM abuse_reports WHERE id = ?').get(reportId) as
        { target_post_id: string | null; target_pulse_item_id: string | null; target_message_id: string | null; status: string | null } | undefined;
    if (!r) return { why: 'No report has that id: list them with reports_list.' };
    if (r.target_pulse_item_id) return { why: `That report is about a Pulse item, which has no hidden state: a person removes it in Settings, at /settings#section=moderation&report=${encodeURIComponent(reportId)}.` };
    if (r.target_message_id) return { why: 'That report is about a chat message, not a post: a person acts on it in Settings.' };
    // The phone files an enterprise's report with its key in the post's place (state-engine getReports): no such post, so a member's.
    const post = r.target_post_id ? db.prepare('SELECT 1 FROM posts WHERE id = ?').get(r.target_post_id) : null;
    if (!post) return { why: 'That report is about a member, not a post: a person acts on it in Settings.' };
    if (r.status !== 'pending' && r.status !== null) return { why: 'That report is already closed: there is nothing to act on.' };
    return { postId: r.target_post_id as string };
}

interface Asked { postIds: string[]; reportIds: string[] }

/** One takedown call, from the post ids and report ids it named. */
function run(grant: AgentGrant, args: Record<string, unknown>, boundary: string, asked: Asked): ToolResult {
    const refused = gate(grant);
    if (refused) return { ok: false, error: refused };
    const reason = normaliseRemovalReason(args.reason);
    if (!reason) return { ok: false, error: `reason must be one of ${REASONS.join(', ')}: nothing was taken down.` };
    const why = cleanMemberText(args.why, TAKEDOWN.whyMax);
    if (!why) return { ok: false, error: 'why is required, for the record in Settings (no author or reporter ever reads it): nothing was taken down.' };
    const kept: { postId?: string | Fenced | null; reportId?: string | Fenced | null; why: string }[] = [];
    const postIds = [...asked.postIds];
    for (const reportId of new Set(asked.reportIds)) {
        const found = postOfReport(reportId);
        if ('postId' in found) postIds.push(found.postId);
        else kept.push({ reportId: shown(reportId, boundary), why: found.why });
    }
    const out = takeDownPosts({
        grant: { id: grant.id, name: cleanMemberText(grant.name, 60), member: grant.member },
        reason, why, via: asked.reportIds.length ? 'reports' : 'ids', postIds, perDay: agentPostsPerDay(),
    });
    for (const k of out.kept) kept.push({ postId: shown(k.postId, boundary), why: k.why });
    const removed = out.removed.map((id) => shown(id, boundary));
    const fenced = [...removed, ...kept.flatMap((k) => [k.postId, k.reportId])].some((v) => v && typeof v === 'object');
    return {
        ok: true, rows: removed.length,
        result: {
            removed, kept, todayCount: out.todayCount, perDay: out.perDay, final_after: out.finalAfter,
            ...(fenced ? { _notice: MEMBER_TEXT_NOTICE } : {}),
        },
    };
}

const REASON_PROP = { type: 'string', enum: REASONS, description: 'what the author reads: spam (spam or a scam), offensive, misleading, unsafe (unsafe or illegal), rules (against the rules)' };
const WHY_PROP = { type: 'string', maxLength: TAKEDOWN.whyMax, description: 'why, in your own words, for the record in Settings: no author or reporter ever reads it' };
const OUT = {
    type: 'object',
    properties: {
        removed: { type: 'array' }, kept: { type: 'array' }, todayCount: { type: 'number' }, perDay: { type: 'number' }, final_after: { type: 'string' },
    },
    required: ['removed', 'kept', 'todayCount', 'perDay', 'final_after'],
};
const LIMITS = `at most ${TAKEDOWN.maxPerCall} posts a call and the owners' daily limit, its own count`;
const WHAT_IT_DOES = `hidden from everyone but its author and the moderators at once, and removed for good after ${TAKEDOWN.holdDays} days unless a person puts it back in Settings; `
    + 'its open reports close and their reporters hear it was removed, and its author reads the reason you pick and never your words; a post with a deal in escrow, or by an owner, an admin or a moderator, stays up and is listed back with why';
const NEVER = "another member's data; it never moves Beans, and it cannot dismiss a report, put a post back, lift a mute, or remove or suspend a member";

export const OWNER_TAKEDOWN_TOOLS: AgentTool[] = [
    {
        name: 'take_down',
        title: 'Take a post down',
        reads: `nothing: it takes down one post, by post_id or by report_id (the post that report is about): ${WHAT_IT_DOES}`,
        never: NEVER,
        ownerOnly: true,
        moderates: true,
        write: true,
        destructive: true,
        inputSchema: {
            type: 'object',
            properties: {
                post_id: { type: 'string', description: 'the post, or leave out and give report_id' },
                report_id: { type: 'string', description: 'the id from reports_list, or leave out and give post_id' },
                reason: REASON_PROP,
                why: WHY_PROP,
            },
            required: ['reason', 'why'],
            additionalProperties: false,
        },
        outputSchema: OUT,
        run: (grant, args, boundary) => {
            const postId = idOf(args.post_id), reportId = idOf(args.report_id);
            if (!postId === !reportId) return { ok: false, error: 'Give post_id or report_id, one of the two: nothing was taken down.' };
            return run(grant, args, boundary, { postIds: postId ? [postId] : [], reportIds: reportId ? [reportId] : [] });
        },
    },
    {
        name: 'take_down_many',
        title: 'Take many posts down',
        reads: `nothing: it takes down many posts in one call, by post_ids or by report_ids, ${LIMITS}: each ${WHAT_IT_DOES}; each author hears once`,
        never: NEVER,
        ownerOnly: true,
        moderates: true,
        write: true,
        destructive: true,
        inputSchema: {
            type: 'object',
            properties: {
                post_ids: { type: 'array', items: { type: 'string' }, maxItems: TAKEDOWN.maxPerCall, description: 'the posts, or leave out and give report_ids' },
                report_ids: { type: 'array', items: { type: 'string' }, maxItems: TAKEDOWN.maxPerCall, description: 'ids from reports_list, or leave out and give post_ids' },
                reason: REASON_PROP,
                why: WHY_PROP,
            },
            required: ['reason', 'why'],
            additionalProperties: false,
        },
        outputSchema: OUT,
        run: (grant, args, boundary) => {
            const posts = Array.isArray(args.post_ids) ? args.post_ids.map(idOf).filter(Boolean) : [];
            const reports = Array.isArray(args.report_ids) ? args.report_ids.map(idOf).filter(Boolean) : [];
            if (!posts.length === !reports.length) return { ok: false, error: 'Give post_ids or report_ids, one of the two: nothing was taken down.' };
            if (posts.length > TAKEDOWN.maxPerCall || reports.length > TAKEDOWN.maxPerCall) {
                return { ok: false, error: `At most ${TAKEDOWN.maxPerCall} a call: nothing was taken down.` };
            }
            return run(grant, args, boundary, { postIds: posts, reportIds: reports });
        },
    },
];
