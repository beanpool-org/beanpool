/**
 * "Wants to join": the requests to join a member's own (local) community, and their answers (design §3.3; the
 * server is apps/server/src/routes/knocks.ts, G6). Any member may answer: tiers gate nothing.
 *
 *   GET  /api/join/knocks?limit&offset       → { knocks: [{ id, pubkey, callsign, message, avatar, fromNode, createdAt }], total }
 *   POST /api/join/knocks/:id/approve        → { knock: { id, status: 'approved' }, invite: { code, expiresAt } }
 *   POST /api/join/knocks/:id/decline        → { knock: { id, status: 'declined' } }
 *
 * "Invite" is an ordinary invite, made by the member who answers, that admits the applicant's key and no other;
 * the applicant's app finds it by itself and they join with one tap. "Not now" tells the applicant nothing beyond "no answer
 * yet". Both go to the member's own community, signed by the member.
 *
 * A community that takes no requests (its operator switched them off, or a node older than them) answers 404:
 * the section is simply not shown.
 */

import { buildSignedHeaders } from './crypto';
import { signedPost } from './node-post';
import type { BeanPoolIdentity } from './identity';

export const KNOCKS_PATH = '/api/join/knocks';
export const KNOCKS_PAGE = 20;

export interface JoinRequest {
    id: string;
    /** The applicant's key: the one the invite will admit. */
    pubkey: string;
    callsign: string;
    message: string;
    avatar: string | null;
    /** Where their app says it came from (`global.beanpool.org`); not checked by anyone. */
    fromNode: string | null;
    createdAt: string;
}

export type InboxResult =
    | { ok: true; knocks: JoinRequest[]; total: number }
    /** No section: this community takes no requests, or this key isn't a member who can answer. */
    | { ok: false; kind: 'hidden' }
    | { ok: false; kind: 'error'; message: string };

export type AnswerResult =
    | { ok: true; status: 'approved' | 'declined' }
    /** The node said no (already answered, lapsed, …), in its words. The list should be read again. */
    | { ok: false; message: string };

const UNREACHABLE = "Couldn't reach your community. Check your connection and try again.";

function readRequest(raw: unknown): JoinRequest | null {
    if (!raw || typeof raw !== 'object') return null;
    const k = raw as Record<string, unknown>;
    if (typeof k.id !== 'string' || typeof k.pubkey !== 'string' || typeof k.callsign !== 'string' || typeof k.message !== 'string') return null;
    return {
        id: k.id,
        pubkey: k.pubkey,
        callsign: k.callsign,
        message: k.message,
        avatar: typeof k.avatar === 'string' && k.avatar ? k.avatar : null,
        fromNode: typeof k.fromNode === 'string' && k.fromNode ? k.fromNode : null,
        createdAt: typeof k.createdAt === 'string' ? k.createdAt : '',
    };
}

async function errorText(res: Response): Promise<string | null> {
    try {
        const body = await res.json();
        return typeof body?.error === 'string' && body.error.trim() ? body.error : null;
    } catch {
        return null;
    }
}

/** The open requests on `anchorUrl`, newest first. Signed over the path alone: the node verifies `ctx.path`. */
export async function fetchJoinRequests(
    anchorUrl: string, identity: BeanPoolIdentity, offset: number = 0,
): Promise<InboxResult> {
    try {
        const headers = await buildSignedHeaders('GET', KNOCKS_PATH, '', identity.privateKey, identity.publicKey);
        const res = await fetch(`${anchorUrl.replace(/\/+$/, '')}${KNOCKS_PATH}?limit=${KNOCKS_PAGE}&offset=${Math.max(0, Math.floor(offset))}`, {
            method: 'GET', headers,
        });
        // 404: requests are off here (or the node predates them). 401/403: not a member who can answer.
        if (res.status === 404 || res.status === 401 || res.status === 403) return { ok: false, kind: 'hidden' };
        if (!res.ok) return { ok: false, kind: 'error', message: (await errorText(res)) ?? UNREACHABLE };
        const body = await res.json().catch(() => null) as { knocks?: unknown; total?: unknown } | null;
        if (!body || !Array.isArray(body.knocks)) return { ok: false, kind: 'error', message: UNREACHABLE };
        const knocks = body.knocks.map(readRequest).filter((k): k is JoinRequest => k !== null);
        const total = typeof body.total === 'number' && Number.isFinite(body.total) ? body.total : knocks.length;
        return { ok: true, knocks, total };
    } catch {
        return { ok: false, kind: 'error', message: UNREACHABLE };
    }
}

async function answer(anchorUrl: string, identity: BeanPoolIdentity, id: string, verb: 'approve' | 'decline'): Promise<AnswerResult> {
    try {
        const res = await signedPost(anchorUrl, `${KNOCKS_PATH}/${encodeURIComponent(id)}/${verb}`, {}, identity);
        if (!res.ok) return { ok: false, message: (await errorText(res)) ?? UNREACHABLE };
        const body = await res.json().catch(() => null) as { knock?: { status?: unknown } } | null;
        const status = body?.knock?.status;
        return status === 'approved' || status === 'declined' ? { ok: true, status } : { ok: true, status: verb === 'approve' ? 'approved' : 'declined' };
    } catch {
        return { ok: false, message: UNREACHABLE };
    }
}

/** "Invite": the node makes an invite for the applicant's key, from this member. */
export function approveJoinRequest(anchorUrl: string, identity: BeanPoolIdentity, id: string): Promise<AnswerResult> {
    return answer(anchorUrl, identity, id, 'approve');
}

/** "Not now": the applicant keeps hearing "no answer yet". */
export function declineJoinRequest(anchorUrl: string, identity: BeanPoolIdentity, id: string): Promise<AnswerResult> {
    return answer(anchorUrl, identity, id, 'decline');
}

export function wantsToJoinTitle(total: number): string {
    return `Wants to join (${total})`;
}

/** Under each request: when, and where they came from. */
export function joinRequestMeta(r: Pick<JoinRequest, 'createdAt' | 'fromNode'>, now: number = Date.now()): string {
    const at = Date.parse(r.createdAt);
    let when = '';
    if (Number.isFinite(at)) {
        const days = Math.floor((now - at) / 86_400_000);
        when = days <= 0 ? 'Asked today' : days === 1 ? 'Asked yesterday' : `Asked ${days} days ago`;
    }
    const from = r.fromNode ? `from ${r.fromNode}` : '';
    return [when, from].filter(Boolean).join(' · ');
}

export const WANTS_TO_JOIN_HELP =
    'People asking to join this community. Invite makes an invite that only their key can use, and their app finds it by itself. '
    + 'Not now tells them nothing more than "no answer yet".';
