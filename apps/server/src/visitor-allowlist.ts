/**
 * What a visitor's row may sign here, in one place (the director's call, 2026-09-26, beanpool-a2).
 *
 * A visitor's row (isLiveVisitor: members.is_visitor, a key a member messaged or paid, or a member of another community,
 * that never joined) acts as a key with no row does, but for what Marty's answer on card visitor-rows gives it: "they
 * receive messages and Beans but see only what a non-member sees". Three review rounds each found one more function
 * that let such a row act as a member (a pledge, a keeper's row, a node role), so the signature middleware
 * (https-server.ts requireSignature) now refuses every signed write from one that VISITOR_WRITES doesn't name, beside
 * #1177's refusals of a replaced key and a closed account, before any route runs and before any activity is stamped.
 * The per-function checks stay behind it, as defence in depth.
 *
 * Reads that aren't writes follow the read gate as before (gatedReadAllowed): under read auth a visitor's row reads only
 * what visitorsOwnRead names, and every public read, as anyone does.
 *
 * Not here, because the middleware never sees them (isSignatureBypassed): its own signed redeem of an invite or an
 * offline ticket (/api/invite/redeem, /api/invite/redeem-offline, whose routes check the signature themselves and make
 * its row a member's), and the admin surface, where a visitor's row holds no role (engine/node-roles.ts NODE_ROLE_ACTS).
 *
 * Federation needs nothing here. Its paths reach a federation visitor's row through the peer protocol and engine calls,
 * never a request that row signs on this node: the relayed DM (federation-protocol.ts relay_message: registerVisitor,
 * then createConversation and sendMessage as the visitor), the settlement exchange (handleReserve: registerVisitor), the
 * listing pull (registerVisitor and a posts insert) and the handshake (registerVisitor). The cross-community purchase
 * and commission (/api/federation/purchase, /api/federation/commission) are the buyer's own node's routes, signed by a
 * member there; a visitor's row signing one here gets this refusal where it had the route's ("buy from home").
 */

import { getConversation, isLiveVisitor, PUSH_PREFERENCE_KEYS } from './state-engine.js';
import { isVisitorsDirectLine, isVisitorsDirectConversation, isVisitorsDirectConversationWith, visitorMaySendTo } from './engine/messaging.js';
import { isOwnListing } from './engine/posts.js';

export interface VisitorWrite {
    method: 'POST' | 'DELETE';
    /** The path as the router registers it. */
    path: string;
    /** Why the rule gives a visitor this. */
    why: string;
    /**
     * When set, the body must also name only the visitor's own: a direct conversation it is in or a line of one, its own
     * listing, or its own push settings.
     */
    own?: (body: Record<string, unknown>, signer: string) => boolean;
}

/**
 * Only push settings (PUSH_PREFERENCE_KEYS): setMemberPreferences stores every key it is given, holiday mode among them,
 * which the gate refuses the visitor at /api/members/holiday (4111438819).
 */
function onlyPushSettings(preferences: unknown): boolean {
    return !!preferences && typeof preferences === 'object' && !Array.isArray(preferences)
        && Object.keys(preferences).every(key => PUSH_PREFERENCE_KEYS.includes(key));
}

export const VISITOR_WRITES: readonly VisitorWrite[] = [
    // Its own direct conversations: Marty's answer gives it its messages, and answering them (the director, fix round 1).
    { method: 'POST', path: '/api/messages/conversation', why: 'an app asks for the DM again before it writes; it opens no new one (assertMayOpenConversation)',
        own: (b, s) => isVisitorsDirectConversationWith(s, b.participants) },
    { method: 'POST', path: '/api/messages/send', why: 'a reply in a DM it is in; an old id is followed by sendMessage, which refuses it anywhere else',
        own: (b, s) => visitorMaySendTo(b.conversationId, s) },
    { method: 'POST', path: '/api/messages/edit', why: 'its own line in a DM it is in (editMessage holds it to its own)',
        own: (b, s) => isVisitorsDirectLine(b.messageId, s) },
    { method: 'POST', path: '/api/messages/delete', why: 'its own line in a DM it is in, for privacy (deleteOwnMessage holds it to its own)',
        own: (b, s) => isVisitorsDirectLine(b.messageId, s) },
    { method: 'POST', path: '/api/messages/react', why: 'a line of a DM it is in, as anyone in a DM',
        own: (b, s) => isVisitorsDirectLine(b.messageId, s) },
    { method: 'POST', path: '/api/messages/mark-read', why: 'a DM it is in', own: (b, s) => isVisitorsDirectConversation(b.conversationId, s) },
    { method: 'POST', path: '/api/messages/mute', why: 'a DM it is in', own: (b, s) => isVisitorsDirectConversation(b.conversationId, s) },
    // Its phone, so a message sent to it reaches it, and stops when it leaves the phone. Each is written for the signer only,
    // and a key with no row may make it too.
    { method: 'POST', path: '/api/push-tokens', why: "its phone's push token: its messages and Beans reach it" },
    { method: 'DELETE', path: '/api/push-tokens', why: "taking its phone's push token away when the account leaves the phone" },
    { method: 'POST', path: '/api/members/preferences', why: 'which of its pushes reach its phone, and no other preference',
        own: b => onlyPushSettings(b.preferences) },
    // Beans.
    { method: 'POST', path: '/api/ledger/transfer', why: 'Beans it holds; the send gate then decides (a first completed trade), and it pays no key with no row' },
    // Its own content from before the rule (the director, 2026-09-26, choice 5 of #1187): taking its own listing down, direct-author
    // removal. Not its event or poll, nor a listing of an enterprise it keeps; pausing a listing and closing a poll stay refused.
    { method: 'POST', path: '/api/marketplace/posts/remove', why: 'taking down an offer or a need it wrote here, as any author takes one down',
        own: (b, s) => isOwnListing(b.id, s) },
    // The join doors, signed by the key that joins; each makes its row a member's.
    { method: 'POST', path: '/api/join', why: 'the open door' },
    { method: 'POST', path: '/api/join/sso-nonce', why: "the open door's sign-in" },
    { method: 'POST', path: '/api/join/github/start', why: "the open door's GitHub sign-in" },
    { method: 'POST', path: '/api/join/github/poll', why: "the open door's GitHub sign-in" },
    { method: 'POST', path: '/api/join/knock', why: 'a knock (its status is a public read)' },
    // What anyone may do, signed or not.
    { method: 'POST', path: '/api/pricing-guide/report', why: 'a price report, which may be anonymous; signed, it only names the reporter' },
];

/** The path the router answers: one trailing slash is the path itself (@koa/router's default, strict: false). */
export function routedPath(path: string): string {
    return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

let enforced = true;
/** Tests only: turn the gate off, so a suite can measure the per-function checks behind it. Nothing in the server calls it. */
export function setVisitorGateForTests(on: boolean): void {
    enforced = on;
}

/**
 * Whether the signature middleware refuses this signed write (`method` is one that writes) from `signer`: a visitor's row
 * (isLiveVisitor), and a write VISITOR_WRITES doesn't name, or names only for the visitor's own (a conversation or a line,
 * a listing, push settings) and this body names more. Compared as the path spells it, so a spelling the router would read as another path is
 * refused, never let through.
 */
export function visitorWriteRefused(method: string, path: string, body: unknown, signer: string): boolean {
    if (!enforced || !isLiveVisitor(signer)) return false;
    const routed = routedPath(path);
    const entry = VISITOR_WRITES.find(w => w.method === method && w.path === routed);
    if (!entry) return true;
    const fields = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    return !!entry.own && !entry.own(fields, signer);
}

/**
 * What a visitor's row (isLiveVisitor) may read past the read gate: only what is its own and was sent to it, its messages
 * and its Beans (#1182). Each is held to the signer here, as the route holds it under read auth: its own conversation
 * list, a direct conversation it is in, its own balance and its own transactions. Every other gated read it is refused,
 * as a non-member is. Compared as the path spells it, as above.
 */
export function visitorsOwnRead(path: string, query: Record<string, unknown>, signer: string): boolean {
    const routed = routedPath(path);
    const conversations = /^\/api\/messages\/conversations\/([^/]+)$/.exec(routed);
    if (conversations) return conversations[1] === signer;
    const conversation = /^\/api\/messages\/([^/]+)$/.exec(routed);
    if (conversation) {
        const conv = getConversation(conversation[1]);
        return !!conv && conv.type === 'dm' && conv.participants.includes(signer);
    }
    const balance = /^\/api\/ledger\/balance\/([^/]+)$/.exec(routed);
    if (balance) return balance[1] === signer;
    if (routed === '/api/ledger/transactions') return query.publicKey === signer;
    return false;
}
