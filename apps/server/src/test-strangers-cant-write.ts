/**
 * A key with no row here writes nothing (security inventory 17 Nov 2026, risk 9: scratch/security/ENTRY-POINTS.md §4).
 *
 * The signature middleware proves only that a caller holds SOME key (https-server.ts requireSignature): a keypair made a
 * moment ago passes it for every write, and each handler or engine decides whether the signer may act. Nothing proved that
 * all of them do. This suite closes the class, over real HTTPS through the real middleware, on a local node (the profile a
 * community like ours runs: NODE_PROFILE unset, so knocks, Beans, enterprises, crowdfunds and group guests are on):
 *
 *   1. The lists. Every write the node serves (every POST, PUT, PATCH and DELETE on every router of the app, read from
 *      router.stack) is in exactly one of STRANGER_REFUSED (a stranger is refused and changes nothing) or STRANGER_MAY (a
 *      stranger may call it: answered, changing only the tables named there, each with a one-line reason). A write in
 *      neither fails here, so a new one must be sorted into one, with a body in BODIES if BAIT does not reach its data. An
 *      entry the node no longer serves fails too. The writes the code lets a key with no row make on purpose, charged to
 *      its address (db/writes-by-address.ts admitByAddress), are found in the source: each caller must be in ADDRESS_CAPPED,
 *      its route on STRANGER_MAY or KNOCKER_MAY with writes_by_address, and reached by the sweep's body.
 *   2. A fresh key. Each write, signed by a key made for that one request (so no per-key limit or spent nonce answers in
 *      its place), with a body that reaches members' things (Alice's offer, event, poll, group, chat lines, trade,
 *      enterprise, crowdfund, Commons decision and project, forum topic, Local knowledge page, invite code, DM; Kim's
 *      request to join) and names the signer wherever a route takes the actor from the body. A refused write, sent that
 *      body (BAIT, or its own in BODIES), is answered neither as done (2xx) nor with a server error (500), changes no table
 *      (every row of every table, hashed, before and after; node_config key by key; only the BOOKKEEPING ones below are
 *      left out, each named with why) and sends nothing out (no Expo push, no web push, no call to any outside host; mail
 *      for another community is a table, so it is watched with the rest). Where that body never reaches the write, the
 *      refusal is the body's, not the gate's: section 5's control and OWN_STATE say which bodies do. A STRANGER_MAY write
 *      is answered as done, changes only its named tables, and sends out only where it says so. The AI assistant switch
 *      is on for the sweeps (off by default, risk 3), so the OAuth door's writes meet the stranger themselves; one row
 *      measures them with it off: each answers 404 and changes nothing.
 *   3. A key with an open request to join (a knock, the door every stranger may use): the same sweep, each key knocking
 *      first through the real door. A knock is no membership: it may act on its own request, phone and browser, and
 *      nothing else; Kim's request is still waiting at the end.
 *   4. The live socket: it reads one message, the heartbeat's ping. A socket signed by a stranger's key, and one unsigned,
 *      send every frame a write would be: nothing changes and nothing leaves.
 *   5. Controls, so the sweep can fail: the same bodies signed by Alice, the owner they name, change something or call out
 *      on many of the writes (the bodies reach real data, so a stranger's "nothing changed" is a refusal), and a row a
 *      stranger planted would be seen by the same snapshot. Among them every write in OWN_STATE (the signer's own switches,
 *      marks, profile, phone and channels), the class where bodies that missed once hid two holes and a write in the wrong
 *      list; each it can't reach says why. And an assistant's consent page, whose ticks live in memory where no snapshot
 *      sees them: its own browser's body sets them, a stranger's same body moves none.
 *
 * The engines the inventory had not traced (pausePost, resumePost, publishKnowledge, deleteGroupPost,
 * removeGroupThreadMessage, skipEventDate, names step-back) are among the swept writes, each with a body that reaches them.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-strangers-cant-write.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_LEDGER_AUTH;
delete process.env.NODE_PROFILE;
// TikTok's relay on, so the Pulse's token exchange reaches its call out (answered by the recorder below, never sent).
process.env.TIKTOK_CLIENT_KEY = 'sw-client-key';
process.env.TIKTOK_CLIENT_SECRET = 'sw-client-secret';

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import nodeHttp from 'node:http';
import nodeHttps from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { pushLeaveText, signedRequestBytes } from '@beanpool/core';
import { signRequest, signSocket, socketBinding, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

// ── the lists ───────────────────────────────────────────────────────────────────────────────────────
/**
 * What a stranger's call to a write it may make is allowed to change: these tables, these keys of node_config (which holds
 * the owners' settings, so it is never allowed whole), and a call out only when `out` says so.
 */
interface May { why: string; tables: string[]; config?: string[]; out?: string }
/** A knock may move the node's measure of how promptly requests are answered, which the directory shows (engine/knocks.ts). */
const KNOCK_MEASURE = 'knockAnswersNoneSince';

/**
 * The writes a key with no row here may call, each with why. Answered as done (section 2 checks it, so each body reaches
 * what its route does), but changing nothing beyond its own tables. Doors that need a secret this sweep never holds (an
 * invite code's redeem, a claim code, a re-key code, a verified sign-in, a pairing's confirm digits, a replication token)
 * are in STRANGER_REFUSED: without the secret they change nothing.
 */
const STRANGER_MAY: Record<string, May> = {
    'POST /api/join/knock': { why: 'asking to join is the stranger\'s own door: its request, and the owners and admins told someone is asking',
        tables: ['join_requests', 'push_notices'], config: [KNOCK_MEASURE], out: 'a push to the owners and admins who answer requests' },
    'DELETE /api/push-tokens': { why: 'taking the signer\'s own phone off: a key with no row has none, so nothing goes', tables: [] },
    'POST /api/channels/mine': { why: 'the signer\'s own Pulse channels, asked by POST: a key with no row has none', tables: [] },
    'POST /api/member/pulse/nudges': { why: 'the signer\'s own Pulse nudges, asked by POST: a key with no row has none', tables: [] },
    'POST /api/recovery/find-nonce': { why: 'a recovering phone\'s first step (its sign-in nonce, held in memory), before any account is found', tables: [] },
    'POST /api/local/admin/auth/challenge': { why: 'starting a Settings sign-in: a challenge held in memory, which only an owner\'s, admin\'s or moderator\'s signature answers', tables: [] },
    'POST /api/local/admin/auth/pairing': { why: 'starting a Settings sign-in by QR: a pairing held in memory, which only a role-holder\'s phone approves', tables: [] },
    'POST /api/local/admin/auth/logout': { why: 'signing out a session the caller does not have: nothing to end', tables: [] },
    'POST /oauth/revoke': { why: 'an assistant\'s token revoke answers 200 to anything (RFC 7009 §2.2), revoking only a token it is sent', tables: [] },
    'POST /api/funnel-event': { why: 'an onboarding step the phone counts (routes/community.ts): a key, not a membership, one of five allowlisted '
        + 'steps into an anonymous count that keeps no key (M2)', tables: ['onboarding_funnel'] },
    'DELETE /api/web-push': { why: 'taking the signer\'s own browser off (routes/web-push.ts, its own row only, the same answer whether it had one): '
        + 'a key with no row has none, so nothing goes', tables: [] },
    'POST /api/pair/init': { why: 'a browser starting a pairing with a phone (routes/pairing.ts, signed or not): a session held in memory, '
        + 'which only the phone that scans its code fills', tables: [] },
    'POST /api/pricing-guide/report': { why: 'a price report, which may be anonymous (the phone sends every one unsigned; https-server.ts '
        + 'isOptionallySignedWrite): a key with no member row files an anonymous one, capped by address and for the node '
        + '(db/pricing-guide-db.ts PRICE_REPORT_RULES), never copied to a standby', tables: ['pricing_reports', 'writes_by_address'] },
    'POST /api/push-tokens/leave/:publicKey': { why: 'a phone\'s leave statement, signed by the key that left it (routes/community.ts): only that '
        + 'key\'s registration of that phone goes, charged to the address and the node\'s day (state-engine.ts STRANGER_LEAVE_RULES), never '
        + 'copied to a standby', tables: ['push_token_leaves', 'writes_by_address'] },
    'POST /api/marketplace/posts/copies/confirm': { why: 'a device\'s word that the signer\'s own copies are still in step at home '
        + '(engine/copy-lease.ts confirmCopies): only copies the signer wrote are taken, and a key with no row has none, so naming a '
        + 'member\'s copy changes nothing (answered with a count of 0, which names no copy)', tables: [] },
};

/** What a key with an open request to join may also do, beyond STRANGER_MAY: its own request, its phone and its browser. */
const KNOCKER_MAY: Record<string, May> = {
    'POST /api/join/knock': { why: 'asking again: its open request is answered as it stands', tables: ['join_requests', 'push_notices'],
        config: [KNOCK_MEASURE], out: 'a push to the owners and admins who answer requests' },
    'POST /api/join/knock/cancel': { why: 'taking back its own request', tables: ['join_requests'] },
    'POST /api/push-tokens': { why: 'its phone, so it hears the answer (web push W4: kept only while its request is open), counted against its address\'s day cap',
        tables: ['push_tokens', 'writes_by_address'] },
    'POST /api/web-push': { why: 'its browser, so it hears the answer (web push W1)', tables: ['web_push_subscriptions'] },
    'DELETE /api/web-push': { why: 'taking its own browser off', tables: ['web_push_subscriptions'] },
};

/**
 * Every write the code lets a key with no member row make on purpose, charged to the request's address and the node's day
 * (db/writes-by-address.ts admitByAddress): its kind, where it is called (file and function), the route that reaches it,
 * and whether a stranger or only a knocking key may. Section 1 reads the callers from the source, so a new one fails until
 * it is listed here and its route is on STRANGER_MAY or KNOCKER_MAY with writes_by_address; sections 2 and 3 check that
 * the sweep's body reaches each one (writes_by_address moves), so what it changes is measured, not a 400.
 */
const ADDRESS_CAPPED: Array<{ kind: string; at: string; route: string; who: 'stranger' | 'knocker' }> = [
    { kind: 'push_token', at: 'state-engine.ts admitStrangersToken', route: 'POST /api/push-tokens', who: 'knocker' },
    { kind: 'push_leave', at: 'state-engine.ts applyPushLeave', route: 'POST /api/push-tokens/leave/:publicKey', who: 'stranger' },
    { kind: 'price_report', at: 'db/pricing-guide-db.ts submitPricingReport', route: 'POST /api/pricing-guide/report', who: 'stranger' },
];

/** Every other write: a stranger, with or without an open request to join, is refused and changes nothing. */
const STRANGER_REFUSED = new Set<string>([
    'DELETE /api/contacts/copy', 'DELETE /api/contacts/former', 'DELETE /api/enterprise/:treasury/backing',
    'DELETE /api/enterprise/:treasury/location', 'DELETE /api/enterprise/:treasury/pledge',
    'DELETE /api/enterprise/:treasury/thread/message/:messageId', 'DELETE /api/enterprises/:treasury/thread/message/:messageId',
    'DELETE /api/events/:postId/skip', 'DELETE /api/global/watches/:id', 'DELETE /api/groups/:id/guests/:key',
    'DELETE /api/groups/:id/invitations/:pubkey', 'DELETE /api/groups/:id/members/:pubkey', 'DELETE /api/groups/:id/posts/:postId',
    'DELETE /api/invite/:code', 'DELETE /api/local/admin/node-roles/:pubkey/:role', 'DELETE /api/local/admin/sync-copy/:copyId',
    'DELETE /api/local/admin/treasury/:treasury/location', 'DELETE /api/local/admin/treasury/:treasury/operators/:pubkey',
    'DELETE /api/names/entries/:id', 'DELETE /api/names/entries/:id/invite', 'DELETE /api/names/vouchers/:member',
    'DELETE /api/pricing-guide/admin/item/:id', 'DELETE /api/recovery/community-copy', 'DELETE /api/recovery/shares',
    'DELETE /api/recovery/shares/sso/:provider', 'DELETE /api/tools/:tool', 'DELETE /api/treasury/:treasury/backing',
    'DELETE /api/treasury/:treasury/location', 'DELETE /api/treasury/:treasury/pledge',
    'DELETE /api/treasury/:treasury/thread/message/:messageId', 'DELETE /api/treasury/:treasury/tools/:tool',
    'DELETE /mcp', 'PATCH /api/groups/:id', 'PATCH /api/groups/:id/members/:pubkey', 'POST /api/admin/check-update', 'POST /api/admin/reports',
    'POST /api/admin/seed-invite', 'POST /api/admin/thresholds', 'POST /api/admin/thresholds/get', 'POST /api/bills',
    'POST /api/bills/:id/decline', 'POST /api/bills/:id/pay', 'POST /api/bills/:id/withdraw', 'POST /api/blocks', 'POST /api/blocks/clear',
    'POST /api/blocks/remove', 'POST /api/commons/decisions', 'POST /api/commons/decisions/:id/jury/answer',
    'POST /api/commons/decisions/:id/reply', 'POST /api/commons/decisions/:id/report', 'POST /api/commons/decisions/:id/vote',
    'POST /api/commons/pay', 'POST /api/commons/projects', 'POST /api/commons/projects/delete', 'POST /api/commons/projects/update',
    'POST /api/community/me/area', 'POST /api/community/me/key-succession', 'POST /api/community/register', 'POST /api/credit/gift',
    'POST /api/credit/known-floor', 'POST /api/crowdfund/projects', 'POST /api/crowdfund/projects/:id/pledge',
    'POST /api/crowdfund/projects/delete', 'POST /api/crowdfund/projects/update', 'POST /api/enterprise',
    'POST /api/enterprise/:treasury/backing', 'POST /api/enterprise/:treasury/backing/release', 'POST /api/enterprise/:treasury/decisions',
    'POST /api/enterprise/:treasury/decisions/:id/vote', 'POST /api/enterprise/:treasury/keepers/:pubkey/remove',
    'POST /api/enterprise/:treasury/keepers/changes/:changeId/object', 'POST /api/enterprise/:treasury/keepers/request',
    'POST /api/enterprise/:treasury/keepers/requests/:requestId/approve', 'POST /api/enterprise/:treasury/keepers/requests/:requestId/decline',
    'POST /api/enterprise/:treasury/keepers/step-down', 'POST /api/enterprise/:treasury/location', 'POST /api/enterprise/:treasury/pause',
    'POST /api/enterprise/:treasury/pledge', 'POST /api/enterprise/:treasury/pledge/release', 'POST /api/enterprise/:treasury/release',
    'POST /api/enterprise/:treasury/resume', 'POST /api/enterprise/:treasury/succession/:proposalId/vote',
    'POST /api/enterprise/:treasury/succession/propose', 'POST /api/enterprise/:treasury/thread/message',
    'POST /api/enterprise/:treasury/thread/remove', 'POST /api/enterprise/:treasury/wind-up/cancel',
    'POST /api/enterprise/:treasury/wind-up/finalise', 'POST /api/enterprise/:treasury/wind-up/initiate',
    'POST /api/enterprises/:treasury/thread/message', 'POST /api/enterprises/:treasury/thread/remove', 'POST /api/events/:postId/skip',
    'POST /api/federation/commission', 'POST /api/federation/purchase', 'POST /api/find/me', 'POST /api/find/name',
    'POST /api/forum/first-looks/:id/no', 'POST /api/forum/first-looks/:id/ok', 'POST /api/forum/first-looks/:id/withdraw',
    'POST /api/forum/label', 'POST /api/forum/posts/:id/edit', 'POST /api/forum/posts/:id/learn-ask', 'POST /api/forum/posts/:id/remove',
    'POST /api/forum/sections', 'POST /api/forum/sections/:id/edit', 'POST /api/forum/told', 'POST /api/forum/topics',
    'POST /api/forum/topics/:id/close', 'POST /api/forum/topics/:id/decision', 'POST /api/forum/topics/:id/follow',
    'POST /api/forum/topics/:id/links', 'POST /api/forum/topics/:id/move', 'POST /api/forum/topics/:id/pin', 'POST /api/forum/topics/:id/poll',
    'POST /api/forum/topics/:id/read', 'POST /api/forum/topics/:id/replies', 'POST /api/friends/add', 'POST /api/friends/remove',
    'POST /api/global/circles/:id/starting', 'POST /api/global/watches', 'POST /api/groups',
    'POST /api/groups/:id/chat/message', 'POST /api/groups/:id/chat/remove', 'POST /api/groups/:id/chat/report',
    'POST /api/groups/:id/decisions', 'POST /api/groups/:id/decisions/:decisionId/vote', 'POST /api/groups/:id/guests',
    'POST /api/groups/:id/join', 'POST /api/groups/:id/keys/:epoch/reject', 'POST /api/groups/:id/keys/epoch', 'POST /api/groups/:id/keys/wrap',
    'POST /api/groups/:id/lead', 'POST /api/groups/:id/members', 'POST /api/groups/:id/succession/:proposalId/vote',
    'POST /api/groups/:id/succession/propose', 'POST /api/invite/asks', 'POST /api/invite/asks/:id/no', 'POST /api/invite/asks/:id/send',
    'POST /api/invite/asks/:id/withdraw', 'POST /api/invite/generate', 'POST /api/invite/redeem', 'POST /api/invite/redeem-offline',
    'POST /api/join', 'POST /api/join/knock/cancel', 'POST /api/join/knocks/:id/approve', 'POST /api/join/knocks/:id/decline',
    'POST /api/join/link', 'POST /api/join/link/sso-nonce', 'POST /api/join/sso-nonce', 'POST /api/join/work', 'POST /api/knowledge/drafts',
    'POST /api/knowledge/drafts/:id/approve', 'POST /api/knowledge/drafts/:id/no', 'POST /api/knowledge/drafts/:id/withdraw',
    'POST /api/knowledge/posts', 'POST /api/knowledge/posts/:id/checked', 'POST /api/knowledge/posts/:id/edit',
    'POST /api/knowledge/posts/:id/helped', 'POST /api/knowledge/posts/:id/outdated', 'POST /api/knowledge/posts/:id/outdated/clear',
    'POST /api/knowledge/posts/:id/take-down', 'POST /api/ledger/transfer', 'POST /api/local/admin/agent/grants',
    'POST /api/local/admin/agent/grants/:id/remove-made', 'POST /api/local/admin/agent/grants/:id/revoke',
    'POST /api/local/admin/agent/posts-per-day', 'POST /api/local/admin/agent/preview', 'POST /api/local/admin/agent/suggestions/:id/decline',
    'POST /api/local/admin/agent/switch', 'POST /api/local/admin/agent/takedowns/:id/remove-now',
    'POST /api/local/admin/agent/takedowns/put-back', 'POST /api/local/admin/alerts-summary', 'POST /api/local/admin/alerts/acknowledge',
    'POST /api/local/admin/alerts/settings', 'POST /api/local/admin/alerts/status', 'POST /api/local/admin/alerts/test',
    'POST /api/local/admin/announcements', 'POST /api/local/admin/app-addresses/check', 'POST /api/local/admin/app-addresses/confirm',
    'POST /api/local/admin/app-addresses/main', 'POST /api/local/admin/app-addresses/remove', 'POST /api/local/admin/app-addresses/spares',
    'POST /api/local/admin/auth/break-glass/enrol', 'POST /api/local/admin/auth/break-glass/issue', 'POST /api/local/admin/auth/enrol',
    'POST /api/local/admin/auth/exchange', 'POST /api/local/admin/auth/pairing/:id/approve', 'POST /api/local/admin/auth/pairing/:id/confirm',
    'POST /api/local/admin/auth/pairing/:id/decline', 'POST /api/local/admin/auth/pairing/:id/wait', 'POST /api/local/admin/auth/revoke-all',
    'POST /api/local/admin/auth/verify-challenge', 'POST /api/local/admin/automation-tokens',
    'POST /api/local/admin/automation-tokens/:id/revoke', 'POST /api/local/admin/backup', 'POST /api/local/admin/backup-config',
    'POST /api/local/admin/backup-status', 'POST /api/local/admin/backup/verify', 'POST /api/local/admin/branches/:pubkey/pause',
    'POST /api/local/admin/branches/:pubkey/prune', 'POST /api/local/admin/bursts/:id/undo', 'POST /api/local/admin/commons/projects',
    'POST /api/local/admin/commons/reject', 'POST /api/local/admin/community-health', 'POST /api/local/admin/community-shape',
    'POST /api/local/admin/community-shape/advice', 'POST /api/local/admin/community-welcome', 'POST /api/local/admin/csrf-token', 'POST /api/local/admin/data',
    'POST /api/local/admin/data/members', 'POST /api/local/admin/data/posts', 'POST /api/local/admin/decisions',
    'POST /api/local/admin/decisions/:id/accelerate', 'POST /api/local/admin/decisions/:id/halt',
    'POST /api/local/admin/decisions/:id/hide-case', 'POST /api/local/admin/decisions/:id/hide-reply',
    'POST /api/local/admin/decisions/:id/owner-decision', 'POST /api/local/admin/diagnostics', 'POST /api/local/admin/directory/promise',
    'POST /api/local/admin/directory/push', 'POST /api/local/admin/disputes/:id/resolve', 'POST /api/local/admin/forum/posts/:id/restore',
    'POST /api/local/admin/free-tags/:key/:action', 'POST /api/local/admin/gateway', 'POST /api/local/admin/health',
    'POST /api/local/admin/inbox', 'POST /api/local/admin/inbox/send', 'POST /api/local/admin/known-floor/exception',
    'POST /api/local/admin/ledger-audit', 'POST /api/local/admin/ledger-rebaseline', 'POST /api/local/admin/lights-out',
    'POST /api/local/admin/logs', 'POST /api/local/admin/members/:pubkey/burst/hide', 'POST /api/local/admin/members/:pubkey/burst/remove',
    'POST /api/local/admin/members/:pubkey/offboard', 'POST /api/local/admin/members/:pubkey/rekey/cancel',
    'POST /api/local/admin/members/:pubkey/rekey/complete', 'POST /api/local/admin/members/:pubkey/rekey/issue-code',
    'POST /api/local/admin/members/:pubkey/rekey/proposals/:newPubkey/decline', 'POST /api/local/admin/members/:pubkey/request-limit/undo',
    'POST /api/local/admin/members/:pubkey/unmute', 'POST /api/local/admin/node-roles', 'POST /api/local/admin/node/config',
    'POST /api/local/admin/offbox-backups/list', 'POST /api/local/admin/offbox-backups/run', 'POST /api/local/admin/offbox-backups/settings',
    'POST /api/local/admin/offbox-backups/status', 'POST /api/local/admin/onboarding-funnel', 'POST /api/local/admin/posts/:id/delete',
    'POST /api/local/admin/posts/:id/restore', 'POST /api/local/admin/posts/bulk-delete', 'POST /api/local/admin/public-address/claim',
    'POST /api/local/admin/public-address/offline', 'POST /api/local/admin/public-address/own',
    'POST /api/local/admin/public-address/release-name', 'POST /api/local/admin/public-address/restart-tunnel',
    'POST /api/local/admin/public-address/rotate', 'POST /api/local/admin/public-address/update', 'POST /api/local/admin/pulse/channels',
    'POST /api/local/admin/pulse/channels/remove', 'POST /api/local/admin/replication-access', 'POST /api/local/admin/replication-config/get',
    'POST /api/local/admin/replication-config/save', 'POST /api/local/admin/replication-resync', 'POST /api/local/admin/replication-token/clear',
    'POST /api/local/admin/replication-token/generate', 'POST /api/local/admin/replication-token/status',
    'POST /api/local/admin/reports/:id/action', 'POST /api/local/admin/reports/:id/dismiss', 'POST /api/local/admin/restore',
    'POST /api/local/admin/restore-points/roll-back', 'POST /api/local/admin/restore/phone/wait', 'POST /api/local/admin/shutdown-status',
    'POST /api/local/admin/shutdown-status/acknowledge', 'POST /api/local/admin/snapshots/config', 'POST /api/local/admin/snapshots/create',
    'POST /api/local/admin/snapshots/list', 'POST /api/local/admin/standby-health', 'POST /api/local/admin/standby-health/forget',
    'POST /api/local/admin/start-community-url', 'POST /api/local/admin/storage/clean', 'POST /api/local/admin/storage/clean-preview',
    'POST /api/local/admin/storage/disk-health', 'POST /api/local/admin/stranded-escrows/:escrowId/write-off', 'POST /api/local/admin/sync-copy',
    'POST /api/local/admin/takeover/cancel', 'POST /api/local/admin/takeover/confirm', 'POST /api/local/admin/takeover/open',
    'POST /api/local/admin/takeover/phone/start', 'POST /api/local/admin/takeover/phone/wait', 'POST /api/local/admin/takeover/progress',
    'POST /api/local/admin/takeover/recovery-code', 'POST /api/local/admin/takeover/recovery-code/check',
    'POST /api/local/admin/takeover/status', 'POST /api/local/admin/takeover/words-checks', 'POST /api/local/admin/treasury',
    'POST /api/local/admin/treasury/:treasury/ceiling', 'POST /api/local/admin/treasury/:treasury/location',
    'POST /api/local/admin/treasury/:treasury/need', 'POST /api/local/admin/treasury/:treasury/offer',
    'POST /api/local/admin/treasury/:treasury/operators', 'POST /api/local/admin/unlock/:sessionId', 'POST /api/local/admin/unlock/cancel',
    'POST /api/local/admin/users/:pubkey/freeze', 'POST /api/local/admin/users/:pubkey/operator', 'POST /api/local/admin/users/:pubkey/prune',
    'POST /api/local/admin/users/:pubkey/retire', 'POST /api/local/admin/users/:pubkey/status', 'POST /api/local/admin/users/:pubkey/suspend',
    'POST /api/local/admin/users/:pubkey/tier', 'POST /api/local/admin/users/:pubkey/unretire', 'POST /api/local/admin/ws-connections',
    'POST /api/local/admin/ws-ticket', 'POST /api/local/claim', 'POST /api/local/connectors', 'POST /api/local/connectors/connect',
    'POST /api/local/connectors/credit-cap', 'POST /api/local/connectors/disconnect', 'POST /api/local/connectors/remove',
    'POST /api/local/federation/links/ceiling', 'POST /api/local/update-identity', 'POST /api/mail/confirm', 'POST /api/mail/device/forget',
    'POST /api/mail/group/confirm', 'POST /api/mail/quiet', 'POST /api/mail/report', 'POST /api/mail/send', 'POST /api/marketplace/polls/close',
    'POST /api/marketplace/polls/vote', 'POST /api/marketplace/posts', 'POST /api/marketplace/posts/:id/chat/message',
    'POST /api/marketplace/posts/:id/chat/remove', 'POST /api/marketplace/posts/:id/close', 'POST /api/marketplace/posts/:id/let-in',
    'POST /api/marketplace/posts/:id/other-answers/:answerId/remove', 'POST /api/marketplace/posts/:id/other-answers/:answerId/report',
    'POST /api/marketplace/posts/:id/pin', 'POST /api/marketplace/posts/:id/rsvp', 'POST /api/marketplace/posts/:id/unpin',
    'POST /api/marketplace/posts/:id/vote', 'POST /api/marketplace/posts/accept', 'POST /api/marketplace/posts/pause',
    'POST /api/marketplace/posts/remove', 'POST /api/marketplace/posts/request', 'POST /api/marketplace/posts/resume',
    'POST /api/marketplace/posts/takes-questions', 'POST /api/marketplace/posts/update', 'POST /api/marketplace/standing/:id/extend',
    'POST /api/marketplace/standing/:id/lower', 'POST /api/marketplace/standing/:id/lower/:changeId/answer',
    'POST /api/marketplace/standing/:id/lower/:changeId/withdraw', 'POST /api/marketplace/standing/:id/stop',
    'POST /api/marketplace/transactions/approve', 'POST /api/marketplace/transactions/cancel',
    'POST /api/marketplace/transactions/cancel-request', 'POST /api/marketplace/transactions/complete',
    'POST /api/marketplace/transactions/reject', 'POST /api/member/channels', 'POST /api/member/channels/:id',
    'POST /api/member/channels/:id/delete', 'POST /api/member/channels/:id/disconnect-oauth', 'POST /api/member/channels/:id/verify-oauth',
    'POST /api/member/pulse/channels/:id/dismiss-nudge', 'POST /api/member/pulse/items/:id/delete', 'POST /api/member/pulse/items/:id/mute',
    'POST /api/member/pulse/oauth-exchange', 'POST /api/member/pulse/oauth-ingest', 'POST /api/member/pulse/preview',
    'POST /api/member/pulse/submit', 'POST /api/member/purge', 'POST /api/member/re-enroll', 'POST /api/members/holiday',
    'POST /api/members/preferences', 'POST /api/messages/conversation', 'POST /api/messages/delete', 'POST /api/messages/edit',
    'POST /api/messages/mark-read', 'POST /api/messages/mute', 'POST /api/messages/react', 'POST /api/messages/report',
    'POST /api/messages/request', 'POST /api/messages/request/ignore-all', 'POST /api/messages/send', 'POST /api/names/committee',
    'POST /api/names/confirmations', 'POST /api/names/confirmations/:id/revoke', 'POST /api/names/confirmations/:id/second',
    'POST /api/names/debts/:id/settle', 'POST /api/names/debts/:id/work-off', 'POST /api/names/entries', 'POST /api/names/entries/:id/invite',
    'POST /api/names/generations', 'POST /api/names/health/settings', 'POST /api/names/settings', 'POST /api/names/shares',
    'POST /api/names/step-back', 'POST /api/names/vouchers', 'POST /api/names/vouchers/:member/budget', 'POST /api/names/vouchers/settings',
    'POST /api/node-admin/break-glass', 'POST /api/node/check', 'POST /api/node/owner/lights-out', 'POST /api/node/owner/lock-open-check',
    'POST /api/node/owner/words-check', 'POST /api/notices/push/seen', 'POST /api/notices/seen', 'POST /api/pair/cancel',
    'POST /api/pair/collect', 'POST /api/pair/confirm', 'POST /api/pair/offer', 'POST /api/pair/saved',
    'POST /api/pair/send', 'POST /api/pair/transfer', 'POST /api/peek', 'POST /api/peek/stop', 'POST /api/pricing-guide/admin/aggregate',
    'POST /api/pricing-guide/admin/config', 'POST /api/pricing-guide/admin/item', 'POST /api/pricing-guide/admin/pin',
    'POST /api/pricing-guide/admin/reset', 'POST /api/pricing-guide/reports/:id/status',
    'POST /api/profile/update', 'POST /api/push-tokens', 'POST /api/ratings',
    'POST /api/recovery/collect', 'POST /api/recovery/collect/cancel', 'POST /api/recovery/collect/fragments', 'POST /api/recovery/collect/hub',
    'POST /api/recovery/collect/mine', 'POST /api/recovery/collect/status', 'POST /api/recovery/community-copy',
    'POST /api/recovery/community-copy/half', 'POST /api/recovery/community-copy/status', 'POST /api/recovery/find',
    'POST /api/recovery/shares/hub-fragment', 'POST /api/recovery/shares/sso', 'POST /api/recovery/shares/status',
    'POST /api/recovery/sso-nonce', 'POST /api/relay/complaint', 'POST /api/relay/find', 'POST /api/relay/group', 'POST /api/relay/mail',
    'POST /api/reports', 'POST /api/shops/mine/close', 'POST /api/shops/mine/offers', 'POST /api/treasury',
    'POST /api/treasury/:treasury/approve', 'POST /api/treasury/:treasury/backing', 'POST /api/treasury/:treasury/backing/release',
    'POST /api/treasury/:treasury/complete', 'POST /api/treasury/:treasury/event', 'POST /api/treasury/:treasury/keepers/:pubkey/remove',
    'POST /api/treasury/:treasury/keepers/changes/:changeId/object', 'POST /api/treasury/:treasury/keepers/request',
    'POST /api/treasury/:treasury/keepers/requests/:requestId/approve', 'POST /api/treasury/:treasury/keepers/requests/:requestId/decline',
    'POST /api/treasury/:treasury/keepers/step-down', 'POST /api/treasury/:treasury/location', 'POST /api/treasury/:treasury/need',
    'POST /api/treasury/:treasury/offer', 'POST /api/treasury/:treasury/pause', 'POST /api/treasury/:treasury/pledge',
    'POST /api/treasury/:treasury/pledge/release', 'POST /api/treasury/:treasury/reject', 'POST /api/treasury/:treasury/release',
    'POST /api/treasury/:treasury/resume', 'POST /api/treasury/:treasury/shop/close', 'POST /api/treasury/:treasury/shop/offers',
    'POST /api/treasury/:treasury/succession/:proposalId/vote', 'POST /api/treasury/:treasury/succession/propose',
    'POST /api/treasury/:treasury/sweep', 'POST /api/treasury/:treasury/thread/message', 'POST /api/treasury/:treasury/thread/remove',
    'POST /api/treasury/:treasury/wind-up/cancel', 'POST /api/treasury/:treasury/wind-up/finalise',
    'POST /api/treasury/:treasury/wind-up/initiate', 'POST /api/trust/profile', 'POST /api/vouch', 'POST /api/vouchers/ask',
    'POST /api/web-push', 'POST /app/auth/apple', 'POST /mcp', 'POST /mcp/photos', 'POST /mcp/photos/u/:token',
    // The consent page's poll, digits and ticks (agent/oauth-route.ts; inside OAUTH_DOOR_PATH, so 404 with the assistant
    // switch off): each answers only the browser holding the request's SameSite cookie, which a stranger never has (403).
    // The ticks are the page's own: set before the phone looks, shown to it and signed by it (section 5's control).
    'POST /oauth/authorize/:id/asks', 'POST /oauth/authorize/:id/confirm', 'POST /oauth/authorize/:id/wait',
    'POST /oauth/register', 'POST /oauth/token', 'PUT /api/contacts/copy',
    'PUT /api/enterprise/:treasury/profile', 'PUT /api/events/:postId/reminder', 'PUT /api/marketplace/posts/:id/feature', 'PUT /api/names/copy',
    'PUT /api/names/entries/:id', 'PUT /api/profile/privacy', 'PUT /api/shops/mine', 'PUT /api/tools/:tool',
    'PUT /api/treasury/:treasury/profile', 'PUT /api/treasury/:treasury/shop', 'PUT /api/treasury/:treasury/tools/:tool',
    'PUT /mcp/photos/u/:token',
]);

/**
 * The writes in STRANGER_REFUSED that keep the signer's OWN things (switches, read marks, follows, blocks, friends, watches,
 * reminders, copies, its profile ...): the class a stranger can reach without touching any member's data, so the class two
 * holes were found in (push switches saved for any key; the node's TikTok relay spent by any key). Each is REACHED: BODIES
 * sends a body that reaches its write, and Alice's same body in the control (section 5) must change something or call out,
 * so the stranger's refusal is real. Or it says why this suite can't reach it.
 */
const REACHED = 'reached';
const GLOBAL_ONLY = 'the global directory\'s: 404 feature_off on a local node before any handler (routes/profile-feature-gate.ts), and '
    + 'its watcher() asks isNodeMember first';
/** Not reached here, but refused before the body is read: `gate` asks for the signer's member row first, whatever the body says. */
const firstAsks = (gate: string, needs: string) => `${gate} asks for the signer's member row before the body is read; ${needs}`;
const CONTACTS = 'asMember (routes/contacts.ts)';
const KEEPERS = 'activeSigner (routes/keepers.ts)';
const MAIL = 'memberHere (routes/relay.ts)';
const OWN_STATE: Record<string, string> = {
    'POST /api/members/preferences': REACHED,
    'POST /api/member/pulse/oauth-exchange': REACHED,
    'POST /api/friends/add': REACHED,
    'POST /api/friends/remove': REACHED,
    'POST /api/blocks': REACHED,
    'POST /api/blocks/clear': REACHED,
    'POST /api/blocks/remove': REACHED,
    'POST /api/forum/topics/:id/follow': REACHED,
    'POST /api/forum/topics/:id/read': REACHED,
    'POST /api/forum/told': REACHED,
    'POST /api/notices/push/seen': REACHED,
    'POST /api/messages/mark-read': REACHED,
    'POST /api/messages/mute': REACHED,
    'POST /api/members/holiday': REACHED,
    'POST /api/community/me/area': REACHED,
    'POST /api/push-tokens': REACHED,
    'POST /api/web-push': REACHED,
    'PUT /api/profile/privacy': REACHED,
    'POST /api/profile/update': REACHED,
    'PUT /api/events/:postId/reminder': REACHED,
    'POST /api/member/channels': REACHED,
    'POST /api/member/pulse/items/:id/mute': REACHED,
    'POST /api/mail/device/forget': REACHED,
    'POST /api/mail/quiet': REACHED,
    'DELETE /api/tools/:tool': REACHED,
    'POST /api/global/watches': GLOBAL_ONLY,
    'DELETE /api/global/watches/:id': GLOBAL_ONLY,
    'POST /api/global/circles/:id/starting': GLOBAL_ONLY,
    'PUT /api/contacts/copy': firstAsks(CONTACTS, 'a body that reaches the write is a copy the sender signed, in whole 16 KiB steps'),
    'DELETE /api/contacts/copy': firstAsks(CONTACTS, 'Alice keeps no copy here to delete'),
    'DELETE /api/contacts/former': firstAsks(CONTACTS, 'Alice was never re-keyed, so keeps no former copy'),
    'POST /api/recovery/community-copy': firstAsks(KEEPERS, 'a body that reaches the write is a sealed copy and its key'),
    'POST /api/recovery/community-copy/half': firstAsks(KEEPERS, 'a body that reaches the write is a sealed half and its copy\'s digest'),
    'DELETE /api/recovery/community-copy': firstAsks(KEEPERS, 'Alice keeps no copy here to delete'),
    'POST /api/recovery/shares/sso': firstAsks(KEEPERS, 'a body that reaches the write is a sign-in the provider verified'),
    'DELETE /api/recovery/shares': firstAsks(KEEPERS, 'Alice keeps no fragments here to delete'),
    'DELETE /api/recovery/shares/sso/:provider': firstAsks(KEEPERS, 'Alice has no sign-in connected'),
    'POST /api/find/me': firstAsks('memberHere (routes/find-by-name.ts)', 'a body that reaches the write carries the verified card'),
    'POST /api/mail/confirm': firstAsks(MAIL, 'Alice has no mail from another community waiting'),
    'POST /api/mail/group/confirm': firstAsks(MAIL, 'Alice has no group notice from another community waiting'),
    'POST /api/notices/seen': firstAsks('member() (routes/notices.ts)', 'Alice\'s kept notices have no fixed ids here'),
    'POST /api/messages/request/ignore-all': firstAsks('requestDecider (routes/messaging.ts; a live visitor too)', 'nobody asked Alice to talk'),
    'POST /api/vouchers/ask': 'its body ({}) reaches askForMore, which asks getMember first (engine/vouchers.ts); Alice, an owner, has no '
        + 'limit to ask past (409 no_limit)',
    'POST /api/member/pulse/preview': 'matchOwnedChannel (routes/pulse-submit.ts) finds the signer\'s own channel before any call out; '
        + 'Alice\'s needs a platform page to answer',
    'POST /api/member/pulse/submit': 'matchOwnedChannel finds the signer\'s own channel before any call out or write; Alice\'s needs a '
        + 'platform page to answer',
};

// ── nothing leaves the node ─────────────────────────────────────────────────────────────────────────
/**
 * Every call the node made to a host that is not this machine: Expo's push service, a browser's push service (web push
 * goes out with the global fetch, services/web-push.ts), another community, a link's preview (engine/pulse-resolver.ts
 * ssrfSafeFetch, https.request), TikTok or Instagram (engine/platform-identity.ts platformRequest, https.request; its
 * recorder is set in main), a public address check, an off-box backup, anything. Answered here, never sent.
 */
const outside: string[] = [];
const isLocal = (host: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    let host = '';
    try { host = new URL(String(url)).hostname; } catch { /* not a URL */ }
    if (host && !isLocal(host)) {
        let to = '';
        if (host === 'exp.host') { try { to = ` (push to ${JSON.parse(String(init?.body ?? '[]')).map((m: any) => m.to).join(', ')})`; } catch { /* not a list */ } }
        outside.push(`${init?.method ?? 'GET'} ${host}${to}`);
        return new Response(host === 'exp.host' ? '{"data":[]}' : '{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
}) as typeof fetch;
/**
 * The same for http.request, https.request and their get: a call to a host not this machine is counted and answered with a
 * refused connection, never made. This suite's own socket (wss://localhost) goes through as it is.
 */
for (const mod of [nodeHttp, nodeHttps] as Array<Record<'request' | 'get', (...a: any[]) => any>>) {
    for (const fn of ['request', 'get'] as const) {
        const real = mod[fn];
        mod[fn] = (...args: any[]) => {
            const [a0, a1] = args;
            const opts = (typeof a0 === 'string' || a0 instanceof URL) ? { ...(a1 && typeof a1 === 'object' ? a1 : {}), url: new URL(String(a0)) } : (a0 ?? {});
            const host = String(opts.url?.hostname ?? opts.hostname ?? opts.host ?? 'localhost').replace(/:\d+$/, '');
            if (isLocal(host)) return real(...args);
            outside.push(`${String(opts.method ?? 'GET').toUpperCase()} ${host}`);
            const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
            const refuse = () => setImmediate(() => { if (req.listenerCount('error')) req.emit('error', new Error(`${host}: no outside call from this suite`)); });
            Object.assign(req, { write: () => true, setHeader: () => req, getHeader: () => undefined, removeHeader: () => req,
                setTimeout: () => req, setNoDelay: () => req, flushHeaders: () => req, destroy: () => req, abort: () => req,
                end: () => { refuse(); return req; } });
            if (fn === 'get') refuse();
            return req;
        };
    }
}
syncBuiltinESMExports();

// ── identities and requests ─────────────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name = 'Stranger'): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}

let BASE = '';
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
interface Res { status: number; body: any; text: string }
async function call(method: Method, id: Id | null, urlPath: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    const bodiless = method === 'GET';
    const raw = bodiless ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = { ...extra };
    if (!bodiless) headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = signRequest(id.priv, { method, path: urlPath.split('?')[0], timestamp: ts, nonce, body: raw });
        headers[SIGNED_FOR_HEADER] = signedForHost();
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${urlPath}`, { method, headers, body: bodiless ? undefined : raw });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed, text };
}
const show = (r: Res) => `${r.status} ${r.text.replace(/\s+/g, ' ').slice(0, 110)}`;
const settle = (ms = 30) => new Promise(r => setTimeout(r, ms));

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';
const hc = (beans: number) => Math.round(beans * 100);

async function main(): Promise<void> {
    console.log('\n=== A key with no row here writes nothing (risk 9) ===\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { wrapCreatePost } = await import('./post-test-helper.js');
    const createPost = wrapCreatePost(se.createPost);
    const https = await import('./https-server.js') as any;
    const { db, createCrowdfundProject } = await import('./db/db.js');
    const { setMemberPhoto } = await import('@beanpool/engine');
    const { putPushTokenRow } = await import('./services/push-token-seal.js');
    const { lockedDm } = await import('./dm-test-payload.js');
    const { lockedGroupLine } = await import('./group-test-payload.js');
    const { addBlocks } = await import('./engine/member-blocks.js');
    const { noteMailDevice } = await import('./engine/relay-mail.js');
    const MAIL_DEVICE = 'a1'.repeat(16);
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    const { resetChatRateLimit } = await import('./chat-rate-limit.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');
    const { resetPasswordBrake } = await import('./password-brake.js');
    const { resetClaimBrake } = await import('./claim-code.js');
    const { tidyKnocks, startTidyingKnocks } = await import('./engine/knocks.js');
    const { tidyPushNotices } = await import('./engine/push-notices.js');
    // TikTok and Instagram, as the platform would answer a good token: counted as a call out, never sent.
    (await import('./engine/platform-identity.js')).setPlatformRequestForTests(async (method, url) => {
        outside.push(`${method} ${new URL(url).hostname}`);
        return { status: 200, json: { access_token: 'at-sw', refresh_token: 'rt-sw', expires_in: 86_400, open_id: 'sw', scope: 'user.info.basic' } };
    });
    /**
     * The node's own tidy-ups, run here between writes, never inside one's window: every knock bells the owners and admins,
     * and a knocking key's phone and browser stay only while its request is open, so after hundreds of knocks the timers
     * (the knocks' every minute, the notices' hygiene) would find work to do, and a write they landed beside would look as
     * though it changed push_notices, push_tokens or web_push_subscriptions. Run first, they find nothing at their tick.
     */
    const tidyNow = () => { tidyKnocks(); tidyPushNotices(); };
    /** Every limiter a caller from this one address meets, cleared before each request: this suite asks what a write DOES, never how often. */
    const resetLimits = () => {
        resetGatewayRateLimit(); pruneAuthAttempts(Date.now() + 120_000); https.resetAdminRateLimit?.(); resetChatRateLimit();
        resetAdminAuthTarpit(); resetPasswordBrake(); resetClaimBrake();
    };
    // The admin tarpit (admin-auth.ts) sleeps before it refuses, ~250 ms on each of ~170 admin writes, three sweeps over:
    // the sleep decides only WHEN its 401 goes out, never what it says or changes, so a timer set from admin-auth fires at
    // once here (as test-guest-view's sweep does). Every other timer keeps its delay.
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        const tarpit = /[\\/]admin-auth\.[cm]?[jt]s:\d+/.test(new Error().stack ?? '');
        return realSetTimeout(fn, tarpit ? 0 : ms, ...args);
    }) as unknown as typeof setTimeout;

    await initTls();
    se.initStateEngine();
    // AI assistants are OFF unless an owner turns them on (risk 3, 18 Nov). With the switch off, the door's writes
    // (/oauth/register, token, revoke and the consent page's wait, confirm and asks) answer 404 before any handler
    // (agent/oauth-route.ts oauthDoorOff), so the sweep would measure the switch, not the door. It is turned on here, so
    // the door meets a stranger as it does on a node whose owners allowed assistants (the larger surface); the last row
    // of section 2 measures the switch off.
    const { updateLocalConfig } = await import('./config/local-config.js');
    updateLocalConfig({ aiAssistantsAllowed: true });
    const port = await https.startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    // ── the community: what a stranger would reach for ─────────────────────────────────────────────────
    const member = (name: string, beans = 100): Id => {
        const id = newId(name);
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                    VALUES (?, ?, 'active', ?, 'seed', ?)`)
            .run(id.pk, name, new Date(Date.now() - 60 * 86_400_000).toISOString(), `INV-${name.toUpperCase()}`);
        setMemberPhoto(db, id.pk, TINY_PNG);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
        se.transfer('genesis', id.pk, hc(beans), `seed ${name}`, 'direct', true);
        return id;
    };
    const founder = newId('FounderSW');
    se.seedGenesisMember(founder.pk, founder.name);
    const alice = member('AliceSW');
    const bob = member('BobSW');
    const carol = member('CarolSW');
    // Alice is an owner: an owner's things are what a stranger would most like to reach (the admin surface refuses a
    // signature anyway; a signed owner-only route outside it checks the signer's role).
    db.prepare("INSERT OR IGNORE INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'owner', 'genesis')").run(alice.pk);
    // Phones to push to: a push a stranger's write caused would be counted above.
    for (const m of [alice, bob, carol, founder]) putPushTokenRow(m.pk, `ExponentPushToken[${m.name}]`, 'android');

    const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
    const offer = (author: Id, title: string) =>
        createPost('offer', 'produce', title, `${title}, fresh`, hc(5), 'fixed', author.pk, -28.55, 153.5, [TINY_PNG])!;
    const aliceOffer = offer(alice, 'Alice seedlings');
    offer(bob, 'Bob bread');
    offer(carol, 'Carol plums');
    const alicePaused = offer(alice, 'Alice winter squash');
    se.pausePost(alicePaused.id, alice.pk);
    // A copy here of a listing of Alice's on another community (engine/event-copy.ts): its lease is kept by her device alone.
    const aliceCopy = offer(alice, 'Alice jam, shown here');
    db.prepare("UPDATE posts SET shown_from_host = 'riverside.example', shown_from_post_id = ? WHERE id = ?").run(crypto.randomUUID(), aliceCopy.id);
    const event = createPost('event', 'community', 'Alice working bee', 'Bring gloves', 0, 'fixed', alice.pk, -28.6, 153.6, [TINY_PNG],
        false, undefined, false, { eventStartAt: inHours(48), eventPlaceName: 'The hall' })!;
    se.rsvpEvent(event.id, bob.pk, 'going');
    const eventLine = se.postEventThreadMessage(event.id, bob.pk, 'I will bring a rake');
    const poll = createPost('poll', 'community', 'Where should the tool library go', 'Pick one', 0, 'fixed', alice.pk, undefined, undefined, undefined,
        false, undefined, false, { pollOptions: [{ id: 'opt_hall', text: 'The hall' }, { id: 'opt_shed', text: 'The shed' }] })!;
    // Alice convenes a group Bob and Carol are in: a chat line of Bob's, a group post of Bob's, a group event of Alice's.
    const club = se.createGroup({ name: 'Garden club SW', createdBy: alice.pk, joinPolicy: 'open' } as any);
    se.joinGroup(club.id, bob.pk);
    se.joinGroup(club.id, carol.pk);
    const clubLine = se.postGroupThreadMessage(club.id, bob.pk, lockedGroupLine(db, club.id));
    const clubPost = createPost('offer', 'produce', 'Bob spare pots', 'For the club', hc(1), 'fixed', bob.pk, undefined, undefined, [TINY_PNG],
        false, undefined, false, { audienceScope: 'group', targetGroupId: club.id })!;
    createPost('event', 'community', 'Club picnic', 'Bring a plate', 0, 'fixed', alice.pk, -28.6, 153.6, [TINY_PNG],
        false, undefined, false, { eventStartAt: inHours(72), eventPlaceName: 'The park', audienceScope: 'group', targetGroupId: club.id });
    // A DM between Alice and Bob, with a line of Bob's.
    const dm = se.createConversation('dm', [alice.pk, bob.pk], alice.pk)!;
    const dmText = lockedDm();
    const dmLine = se.sendMessage(dm.id, bob.pk, dmText.ciphertext, dmText.nonce)!;
    // A trade: Bob asked for Alice's offer.
    const trade = se.requestPost(aliceOffer.id, bob.pk);
    // A crowdfund of Alice's, an enterprise she leads and Bob keeps, a Commons project and a Commons decision of hers.
    const crowdfund = newId().pk;
    createCrowdfundProject(crowdfund, alice.pk, 'Community oven SW', 'A wood-fired oven', [TINY_PNG], hc(500), null);
    const enterprise = se.createTreasury('Tool library SW', TINY_PNG, 0, { leadKeeperPubkey: alice.pk, purpose: 'Tools to borrow' } as any).publicKey;
    se.adminAssignTreasuryOperator(enterprise, bob.pk);
    const project = se.createProject(alice.pk, 'Community garden SW', 'Beds by the hall', hc(50))!;
    db.prepare(`INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, subject, params, franchise, closes_at)
                VALUES ('dec-sw', ?, 'Suspend a member', 'Reasons', 'member', 'suspend', ?, ?, '1m1v', ?)`)
        .run(alice.pk, carol.pk, JSON.stringify({ memberPubkey: carol.pk }), inHours(120));
    // The Pulse: a channel and an item of Alice's.
    db.prepare(`INSERT INTO creator_channels (id, owner_pubkey, platform, url, handle, category) VALUES ('chan-sw', ?, 'youtube', 'https://youtube.example/@alicesw', 'alicesw', 'food')`)
        .run(alice.pk);
    db.prepare(`INSERT INTO pulse_items (id, channel_id, owner_pubkey, platform, url, title, published_at, category, source)
                VALUES ('item_sw', 'chan-sw', ?, 'youtube', 'https://youtube.example/watch?v=sw', 'A video', ?, 'food', 'manual')`)
        .run(alice.pk, new Date().toISOString());
    const shop = (await import('./engine/shops.js')).openShop(alice.pk).id;
    // Kim, a stranger, has asked to join: a request any member may answer (a stranger answering it would let someone in).
    const kim = newId('KimSW');
    const kimKnock = await call('POST', kim, '/api/join/knock', { callsign: 'Kim asks', message: 'I live down the road and grow garlic.' });
    if (kimKnock.status !== 201) throw new Error(`setup: Kim's knock was answered ${show(kimKnock)}`);
    const kimKnockId = (db.prepare('SELECT id FROM join_requests WHERE pubkey = ?').get(kim.pk) as { id: string }).id;
    // A forum topic of Alice's in General with Bob's reply; a page of Local knowledge (an owner's); an invite code of Alice's.
    const general = ((await call('GET', alice, '/api/forum')).body?.sections ?? []).find((x: any) => x.starter === 'general')?.id as string;
    const topic = await call('POST', alice, '/api/forum/topics', { sectionId: general, title: 'Where to buy seed garlic', words: 'Any local growers?' });
    if (topic.status !== 201) throw new Error(`setup: Alice's topic was answered ${show(topic)}`);
    const reply = await call('POST', bob, `/api/forum/topics/${topic.body.topic.id}/replies`, { words: 'Kim down the road has some.' });
    if (reply.status !== 201) throw new Error(`setup: Bob's reply was answered ${show(reply)}`);
    const page = await call('POST', alice, '/api/knowledge/posts', { title: 'How the tip sorts glass', body: 'Green bins for glass.', topic: 'local-services' });
    if (page.status !== 201) throw new Error(`setup: Alice's page was answered ${show(page)}`);
    const invite = await call('POST', alice, '/api/invite/generate', { publicKey: alice.pk });
    const inviteCode = invite.body?.invite?.code as string;
    if (!inviteCode) throw new Error(`setup: Alice's invite was answered ${show(invite)}`);
    // An item of the price guide, which every node seeds at boot (db/pricing-guide-db.ts seedPricingGuideIfEmpty).
    const priceItem = (db.prepare('SELECT id FROM pricing_guide_items ORDER BY id LIMIT 1').get() as { id: string } | undefined)?.id;
    if (!priceItem) throw new Error('setup: the price guide has no items');
    // An assistant asking to connect, registered through the door as one registers. Its consent page, opened as a browser
    // opens it, holds a live request bound to that browser by a SameSite cookie (agent/oauth-route.ts GET /oauth/authorize).
    // The page's three writes (its poll, its digits, its ticks) are swept against a request opened just before each
    // (PATHS), so a stranger's refusal is the cookie's, never an id that names no request.
    const ASSISTANT_REDIRECT = 'https://assistant.example/oauth/callback';
    const assistant = await call('POST', null, '/oauth/register', { client_name: 'Swept assistant', redirect_uris: [ASSISTANT_REDIRECT] });
    const assistantId = assistant.body?.client_id as string;
    if (assistant.status !== 201 || !assistantId) throw new Error(`setup: the assistant's registration was answered ${show(assistant)}`);
    const openConsent = async (): Promise<{ id: string; cookie: string }> => {
        const u = new URL(`${BASE}/oauth/authorize`);
        const challenge = crypto.createHash('sha256').update(crypto.randomBytes(32).toString('base64url')).digest('base64url');
        for (const [k, v] of Object.entries({ response_type: 'code', client_id: assistantId, redirect_uri: ASSISTANT_REDIRECT, state: 'sw',
            code_challenge: challenge, code_challenge_method: 'S256', scope: 'agent' })) u.searchParams.set(k, v);
        const res = await fetch(u, { redirect: 'manual' });
        const html = await res.text();
        const id = /var id="([0-9a-f]{64})"/.exec(html)?.[1] ?? '';
        const cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).find(c => c.startsWith('bp_signin_')) ?? '';
        if (res.status !== 200 || !id || !cookie) throw new Error(`setup: the consent page was answered ${res.status}`);
        return { id, cookie };
    };
    /** The ticks the phone is shown a consent page asks for (its lookup, as the app reads it before it approves). */
    const asksShown = async (id: string) => (await call('GET', null, `/api/local/admin/auth/pairing/${id}`)).body?.agent?.asks;
    await settle(200);

    // ── 1. the writes, and the two lists ─────────────────────────────────────────────────────────────
    console.log('── 1. every write the node serves is sorted: a stranger is refused, or may call it with a reason ──');
    const app = https.getKoaApp();
    const writes = [...new Set<string>(app.middleware.filter((m: any) => m.router).flatMap((m: any) => m.router.stack)
        .flatMap((l: any) => (l.methods as string[]).filter(m => !['GET', 'HEAD', 'OPTIONS'].includes(m)).map(m => `${m} ${l.path}`)))].sort();
    const unsorted = writes.filter(r => !STRANGER_REFUSED.has(r) && !(r in STRANGER_MAY));
    const both = writes.filter(r => STRANGER_REFUSED.has(r) && r in STRANGER_MAY);
    const gone = [...STRANGER_REFUSED, ...Object.keys(STRANGER_MAY), ...Object.keys(KNOCKER_MAY)].filter(r => !writes.includes(r));
    assert(writes.length > 450 && unsorted.length === 0, `every one of the ${writes.length} writes the node serves is in STRANGER_REFUSED or STRANGER_MAY `
        + `(a new write must be sorted into one)${unsorted.length ? ` — not sorted: ${unsorted.join(', ')}` : ''}`);
    assert(both.length === 0, `no write is in both lists${both.length ? ` — ${both.join(', ')}` : ''}`);
    assert(gone.length === 0, `every listed write is one the node serves${gone.length ? ` — not served: ${gone.join(', ')}` : ''}`);
    console.log(`  (${STRANGER_REFUSED.size} refused to a stranger, ${Object.keys(STRANGER_MAY).length} a stranger may call; `
        + `a key with an open request to join may also call ${Object.keys(KNOCKER_MAY).filter(r => !(r in STRANGER_MAY)).length} more)`);
    {
        // The writes the code lets a key with no row make on purpose: every call of admitByAddress in the server's code (its
        // own definition aside), by the kind it names and the function it sits in. A fourth fails here until it is listed.
        const src = path.dirname(fileURLToPath(import.meta.url));
        const found: string[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const f = path.join(dir, e.name);
                if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '__tests__') walk(f); continue; }
                if (!/\.ts$/.test(e.name) || /^test-|\.test\.ts$/.test(e.name)) continue;
                const text = fs.readFileSync(f, 'utf8');
                for (const m of text.matchAll(/\badmitByAddress\(([^)]*)/g)) {
                    if (/^\s*kind\s*:/.test(m[1])) continue; // the definition, db/writes-by-address.ts
                    const kind = /^\s*'([a-z_]+)'/.exec(m[1])?.[1] ?? `(a kind not written out: ${m[1].trim().slice(0, 40)})`;
                    const fn = [...text.slice(0, m.index).matchAll(/\bfunction\s+([A-Za-z0-9_]+)\s*\(/g)].pop()?.[1] ?? '(outside a function)';
                    found.push(`${kind} at ${path.relative(src, f).split(path.sep).join('/')} ${fn}`);
                }
            }
        };
        walk(src);
        const listed = ADDRESS_CAPPED.map(a => `${a.kind} at ${a.at}`);
        assert(JSON.stringify([...found].sort()) === JSON.stringify([...listed].sort()),
            `the code's calls of admitByAddress are the ${listed.length} in ADDRESS_CAPPED and no others (found ${found.length}: ${found.join('; ')})`);
        const offList = ADDRESS_CAPPED.filter(a => !(a.who === 'stranger' ? STRANGER_MAY : KNOCKER_MAY)[a.route]?.tables.includes('writes_by_address'))
            .map(a => `${a.route} (${a.who === 'stranger' ? 'STRANGER_MAY' : 'KNOCKER_MAY'})`);
        assert(offList.length === 0, `each of their routes is on STRANGER_MAY or KNOCKER_MAY, with writes_by_address among its tables`
            + `${offList.length ? ` — not: ${offList.join(', ')}` : ''}`);
    }

    const ID_BY_PREFIX: Array<[RegExp, string]> = [
        [/^\/api\/groups\//, club.id], [/^\/api\/marketplace\/posts\/:id\/chat/, event.id], [/^\/api\/marketplace\/posts\/:id\/vote/, poll.id],
        [/^\/api\/marketplace\/posts\//, aliceOffer.id],
        [/^\/api\/events\//, event.id], [/^\/api\/commons\/decisions\//, 'dec-sw'], [/^\/api\/commons\/projects\//, project.id],
        [/^\/api\/crowdfund\/projects\//, crowdfund], [/^\/api\/messages\//, dmLine.id], [/^\/api\/pulse\/items\//, 'item_sw'],
        [/^\/api\/member\/pulse\/items\//, 'item_sw'], [/^\/api\/member\/(pulse\/)?channels\//, 'chan-sw'], [/^\/api\/shops\//, shop],
        [/^\/api\/local\/admin\/posts\//, aliceOffer.id], [/^\/api\/local\/admin\/decisions\//, 'dec-sw'],
        [/^\/api\/join\/knocks\//, kimKnockId], [/^\/api\/forum\/topics\//, topic.body.topic.id], [/^\/api\/forum\/posts\//, reply.body.post.id],
        [/^\/api\/forum\/sections\//, general], [/^\/api\/knowledge\/posts\//, page.body.post.id],
        [/^\/api\/local\/admin\/forum\/posts\//, reply.body.post.id],
    ];
    const materialise = (routePath: string) => routePath
        .replace('(.*)', 'sw')
        .replace(/:([A-Za-z]+)/g, (_, name: string) => {
            if (name === 'id') return ID_BY_PREFIX.find(([re]) => re.test(routePath))?.[1] ?? 'sw';
            return ({
                treasury: enterprise, pubkey: alice.pk, publicKey: alice.pk, memberPubkey: alice.pk, member: alice.pk, newPubkey: alice.pk,
                postId: routePath.startsWith('/api/groups/') ? clubPost.id : event.id, groupId: club.id,
                conversationId: dm.id, messageId: dmLine.id, decisionId: 'dec-sw',
                callsign: 'AliceSW', orderNum: '0', code: inviteCode, role: 'owner', provider: 'google', epoch: '1',
            } as Record<string, string>)[name] ?? 'sw';
        });
    /** A write's body, unless the route has its own: the signer wherever a route names who acts, a member's things everywhere else. */
    const bait = (signer: Id): Record<string, unknown> => {
        const k = signer.pk;
        return {
            publicKey: k, authorPublicKey: k, buyerPublicKey: k, cancellerPublicKey: k, confirmerPublicKey: k, voterPublicKey: k,
            authorPubkey: k, from: k, createdBy: k, reporterPubkey: k, raterPubkey: k, ownerPubkey: k, fromPubkey: k,
            creatorPubkey: k, proposerPubkey: k,
            targetPubkey: alice.pk, friendPubkey: alice.pk, memberPubkey: alice.pk, toPubkey: alice.pk, to: alice.pk,
            candidatePubkey: bob.pk, candidate: bob.pk, subject: carol.pk,
            id: aliceOffer.id, postId: aliceOffer.id, targetPostId: aliceOffer.id, groupId: club.id, targetGroupId: club.id,
            conversationId: dm.id, messageId: dmLine.id, transactionId: trade.id, projectId: crowdfund, decisionId: 'dec-sw',
            treasury: enterprise, enterprise, channelId: 'chan-sw', itemId: 'item_sw', shopId: shop, topicId: topic.body.topic.id,
            // No invite, claim or re-key code: a stranger holding a good one may come in (the invite door), which is no hole.
            sectionId: general, knockId: kimKnockId,
            type: 'offer', category: 'produce', title: 'Swept SW', description: 'Swept for the rule', price_c: hc(1), priceType: 'fixed',
            amount_c: hc(1), goalAmount_c: hc(10), requestedAmount_c: hc(10),
            ...lockedDm(), emoji: '👍', stars: 5, reason: 'spam', callsign: 'Swept SW', name: 'Swept SW', bio: 'Swept',
            text: 'Swept line', message: 'Swept line', words: 'Swept words', status: 'going', support: true, choice: 'yes', optionId: 'opt_hall',
            enabled: false, duration: '8h', lat: -28.5, lng: 153.5, radiusKm: 10, date: '2030-01-01',
            token: 'ExponentPushToken[swept]', platform: 'android', preferences: { chat: true },
            touches: 'member', effect: 'suspend', photos: [TINY_PNG],
        };
    };
    /** A phone's leave statement, as the app signs one when an account leaves it: `x` no longer wants this token here. */
    const leaveStatement = (x: Id) => {
        const token = 'ExponentPushToken[swept-leave]';
        const leftAt = Date.now();
        const text = pushLeaveText(signedForHost(), x.pk, token, leftAt);
        return { token, leftAt, signedFor: signedForHost(), signature: crypto.sign(null, signedRequestBytes(text), x.priv).toString('base64') };
    };
    /**
     * A write's own path, where the route's key names the signer itself (materialise names Alice), or a live request the
     * route acts on. Made before the write's snapshot, so making it is not counted as the write's.
     */
    const PATHS: Record<string, (signer: Id) => string | Promise<string>> = {
        'POST /api/push-tokens/leave/:publicKey': (x) => `/api/push-tokens/leave/${x.pk}`,
        // A live consent request's page, its own browser's: the sweep's caller holds no cookie of it.
        'POST /oauth/authorize/:id/asks': async () => `/oauth/authorize/${(await openConsent()).id}/asks`,
        'POST /oauth/authorize/:id/confirm': async () => `/oauth/authorize/${(await openConsent()).id}/confirm`,
        'POST /oauth/authorize/:id/wait': async () => `/oauth/authorize/${(await openConsent()).id}/wait`,
    };
    /** A write's own body, where BAIT won't reach the part of it a stranger would want. */
    const BODIES: Record<string, (signer: Id) => Record<string, unknown>> = {
        // A member steps back for themselves only: any body is refused before the engine, so none is sent (routes/names-list.ts).
        'POST /api/names/step-back': () => ({}),
        // A line in Alice's group's chat, sealed under its epoch as the apps send one: past the shape checks to who may write.
        'POST /api/groups/:id/chat/message': () => ({ ...lockedGroupLine(db, club.id) }),
        // A DM line: Alice and Bob's conversation, in the encrypted form the route takes.
        'POST /api/messages/send': () => ({ conversationId: dm.id, ...lockedDm() }),
        // Bob's line in Alice's group, and his line in her event's chat: removed (a convenor's and a host's power).
        'POST /api/groups/:id/chat/remove': () => ({ messageId: clubLine.id }),
        'POST /api/marketplace/posts/:id/chat/remove': () => ({ messageId: eventLine.id }),
        // A vote in Alice's poll, as a member's phone sends one.
        'POST /api/marketplace/polls/vote': (x) => ({ postId: poll.id, voterPublicKey: x.pk, optionId: 'opt_hall' }),
        'POST /api/marketplace/posts/:id/vote': (x) => ({ voterPublicKey: x.pk, optionId: 'opt_hall' }),
        // Putting Alice's paused offer back up, and pausing her live one (the signer as the author, as the middleware holds it).
        'POST /api/marketplace/posts/resume': (x) => ({ postId: alicePaused.id, authorPublicKey: x.pk }),
        'POST /api/marketplace/posts/pause': (x) => ({ postId: aliceOffer.id, authorPublicKey: x.pk }),
        // Alice's copy named in a device's confirm: the lease of the signer's own copies (only Alice's device keeps hers).
        'POST /api/marketplace/posts/copies/confirm': () => ({ ids: [aliceCopy.id] }),
        // Alice's event moved, by its id: the answer would tell everyone going.
        'POST /api/marketplace/posts/update': (x) => ({ id: event.id, authorPublicKey: x.pk, title: 'Working bee moved', eventPlaceName: 'The car park' }),
        // Bob's ask for Alice's offer, decided by the signer as if they were its author.
        'POST /api/marketplace/transactions/approve': (x) => ({ transactionId: trade.id, authorPublicKey: x.pk }),
        'POST /api/marketplace/transactions/reject': (x) => ({ transactionId: trade.id, authorPublicKey: x.pk }),
        // Beans from the signer to Alice.
        'POST /api/ledger/transfer': (x) => ({ from: x.pk, to: alice.pk, amount_c: hc(1), memo: 'Swept' }),
        // Answering Kim's request to join (an approval mints an invite).
        'POST /api/join/knocks/:id/approve': () => ({}),
        'POST /api/join/knocks/:id/decline': () => ({}),
        // Cancelling a date of Alice's event, and bringing it back.
        'POST /api/events/:postId/skip': () => ({ date: String(event.eventStartAt ?? '').slice(0, 10) }),
        'DELETE /api/events/:postId/skip': () => ({ date: String(event.eventStartAt ?? '').slice(0, 10) }),
        // A reply in Alice's topic, and Bob's reply edited.
        'POST /api/forum/topics/:id/replies': () => ({ words: 'A stranger writes here' }),
        'POST /api/forum/posts/:id/edit': () => ({ words: 'A stranger edits this' }),
        // A page of Local knowledge, as an owner writes one.
        'POST /api/knowledge/posts': () => ({ title: 'A stranger page', body: 'Words', topic: 'local-services' }),
        // Asking to join, and a browser's real push keys (web push W1), past the shape checks to who may.
        'POST /api/join/knock': () => ({ callsign: 'Swept knocker', message: 'Swept, asking to join' }),
        'POST /api/join/knock/cancel': () => ({}),
        'POST /api/web-push': () => ({ subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/swept',
            keys: { p256dh: (() => { const e = crypto.createECDH('prime256v1'); e.generateKeys(); return e.getPublicKey().toString('base64url'); })(),
                auth: crypto.randomBytes(16).toString('base64url') } } }),
        // A refresh through the node's TikTok app, naming no channel (a plain relay): it spends the node's hourly allowance.
        'POST /api/member/pulse/oauth-exchange': () => ({ platform: 'tiktok', grantType: 'refresh_token', refreshToken: 'rt-swept' }),
        // A real push switch, turned off (BAIT's `chat` is no push key, so it never reached the write).
        'POST /api/members/preferences': (x) => ({ publicKey: x.pk, preferences: { notify_chat: false } }),
        // An onboarding step the phone counts.
        'POST /api/funnel-event': () => ({ event: 'guide_complete', variant: 'sw' }),
        // A price report on an item of the guide, as the phone sends one (BAIT names no item of the guide and no report type).
        'POST /api/pricing-guide/report': () => ({ itemId: priceItem, reportType: 'too_high' }),
        // The signer's own leave statement for a phone's token, presented at its own key's path (PATHS), as a phone presents one.
        'POST /api/push-tokens/leave/:publicKey': (x) => leaveStatement(x),
        // A browser opening a pairing, as the web app opens one.
        'POST /api/pair/init': () => ({ sessionId: crypto.randomBytes(16).toString('hex'), desktopPubHex: crypto.randomBytes(32).toString('hex') }),
        // A browser taken off by the id its subscription was given (BAIT has no id, so it never reached the removal).
        'DELETE /api/web-push': () => ({ subId: 'ab'.repeat(32) }),
        // The open door's work, as a joining phone asks for it. The door is a profile's switch (routes/open-join.ts doorOpen),
        // off on a local node, so every key is told the community is invite-only (404): refused, here, before the door.
        'POST /api/join/work': () => ({ door: 'words' }),
        // ── the signer's own things (OWN_STATE): bodies that reach each write, so Alice's changes something ──
        // Bob added as a friend, then taken off again.
        'POST /api/friends/add': () => ({ friendPubkey: bob.pk }),
        'POST /api/friends/remove': () => ({ friendPubkey: bob.pk }),
        // Carol blocked, the list cleared; and one block taken off (Alice has one to take off: cleared just before).
        'POST /api/blocks': () => ({ targetPubkey: carol.pk }),
        'POST /api/blocks/clear': () => ({}),
        'POST /api/blocks/remove': (x) => { if (x === alice) addBlocks(alice.pk, [carol.pk]); return { targetPubkey: carol.pk }; },
        // Alice's topic followed, and read to its second post (Bob's reply).
        'POST /api/forum/topics/:id/follow': () => ({ follow: 'following' }),
        'POST /api/forum/topics/:id/read': () => ({ upTo: 2 }),
        // The bell cleared: the signer's own notices only (Alice's say Kim and the knockers asked to join).
        'POST /api/notices/push/seen': () => ({ all: true }),
        // Who invited the signer, hidden; a line about them; a reminder an hour before Alice's working bee.
        'PUT /api/profile/privacy': () => ({ inviterShown: false }),
        'POST /api/profile/update': () => ({ bio: 'A stranger writes this' }),
        // (Alice going to her own working bee first: a reminder is kept on the signer's own RSVP.)
        'PUT /api/events/:postId/reminder': (x) => { if (x === alice) se.rsvpEvent(event.id, alice.pk, 'going'); return { offsets: [60] }; },
        // A Pulse channel of the signer's own, and Alice's video muted on her own channel.
        'POST /api/member/channels': () => ({ platform: 'youtube', url: 'https://www.youtube.com/@sweptchannel', category: 'food' }),
        // (Her video put back first: deleting her channel, earlier in the control's pass, took it down.)
        'POST /api/member/pulse/items/:id/mute': (x) => {
            if (x === alice) db.prepare("UPDATE pulse_items SET deleted_at = NULL WHERE id = 'item_sw'").run();
            return { muted: true };
        },
        // A phone's mail id forgotten (Alice's noted just before, so hers has one to forget).
        'POST /api/mail/device/forget': (x) => { if (x === alice) noteMailDevice(alice.pk, MAIL_DEVICE); return { device: MAIL_DEVICE }; },
        // Someone in another community made quiet (slice S4): kept as that across chat's mute, the signer's own.
        'POST /api/mail/quiet': () => ({ key: 'e'.repeat(64), quiet: true }),
        // One tap, no words (a body that says anything is refused before the engine is asked).
        'POST /api/vouchers/ask': () => ({}),
        // Both of a consent page's ticks on, as the page sends them (BAIT names neither, so it would ask for none): the
        // request's own browser sets what the phone is shown (section 5's control); a stranger's same body is refused.
        'POST /oauth/authorize/:id/asks': () => ({ canPost: true, canModerate: true }),
        // The page's six digits (BAIT has no code), and its poll without the long wait.
        'POST /oauth/authorize/:id/confirm': () => ({ code: '123456' }),
        'POST /oauth/authorize/:id/wait': () => ({ wait: false }),
    };
    const unservedBodies = [...Object.keys(BODIES), ...Object.keys(PATHS)].filter(r => !writes.includes(r));
    assert(unservedBodies.length === 0, `every body written for a route is for one the node serves, so none goes unsent${unservedBodies.length ? ` — not served: ${unservedBodies.join(', ')}` : ''}`);

    // ── the tables ───────────────────────────────────────────────────────────────────────────────────
    /** The node's own record of being asked, which a refused request may write: nothing a member reads as theirs or acts on. */
    const BOOKKEEPING: Record<string, string> = {
        system_logs: "the node's own log (logger.ts): a refused request may leave a line there, as a server logs a refusal",
    };
    /** The same, for single keys of node_config, which otherwise holds the owners' settings and is watched key by key. */
    const BOOKKEEPING_CONFIG: Record<string, string> = {
        replication_access: "the Replication Access panel's count of refused pulls (routes/backup.ts replicationAuth): owners see who tried",
    };
    const tableNames = () => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
        .map(t => t.name);
    /**
     * Every table's row count and a hash of every row, but the bookkeeping ones; node_config key by key. `withoutStamp`: a
     * member's row without its last-activity stamp, which every write a member signs moves (engine/members.ts
     * recordActivity, never for a key with no row), so the control below counts only what a write itself changed.
     */
    function snapshot(withoutStamp = false): Map<string, string> {
        const out = new Map<string, string>();
        for (const name of tableNames()) {
            if (name in BOOKKEEPING) continue;
            if (name === 'node_config') {
                for (const row of db.prepare('SELECT key, value FROM node_config').all() as Array<{ key: string; value: string }>) {
                    if (!(row.key in BOOKKEEPING_CONFIG)) out.set(`node_config.${row.key}`, String(row.value));
                }
                continue;
            }
            const h = crypto.createHash('sha256');
            let n = 0;
            for (const row of db.prepare(`SELECT * FROM "${name}"`).iterate() as Iterable<Record<string, unknown>>) {
                if (withoutStamp && name === 'members') delete row.last_active_at;
                h.update(JSON.stringify(row));
                n++;
            }
            out.set(name, `${n}:${h.digest('hex')}`);
        }
        return out;
    }
    const differing = (a: Map<string, string>, b: Map<string, string>) => [...new Set([...a.keys(), ...b.keys()])].filter(t => a.get(t) !== b.get(t));
    /** The tables that differ, node_config's keys folded into node_config. */
    const changedTables = (a: Map<string, string>, b: Map<string, string>) =>
        [...new Set(differing(a, b).map(t => t.startsWith('node_config.') ? 'node_config' : t))];

    /** One write, signed by `signer`: its answer, the tables it changed, the node_config keys among them, and what left the node. */
    const measure = async (route: string, signer: Id, withoutStamp = false) => {
        const [method, routePath] = route.split(' ') as [Method, string];
        const body = (BODIES[route] ?? bait)(signer);
        const urlPath = await (PATHS[route]?.(signer) ?? materialise(routePath));
        resetLimits();
        const before = snapshot(withoutStamp);
        const sent = outside.length;
        const r = await call(method, signer, urlPath, body);
        await settle();
        const after = snapshot(withoutStamp);
        return { r, changed: changedTables(before, after), config: differing(before, after).filter(t => t.startsWith('node_config.')), left: outside.slice(sent) };
    };
    type Measured = Awaited<ReturnType<typeof measure>>;
    /** The address-charged writes (ADDRESS_CAPPED) whose measured call did not reach the count, each with its answer. */
    const notCounted = (which: typeof ADDRESS_CAPPED, got: Map<string, Measured>) => which
        .filter(a => !got.get(a.route)?.changed.includes('writes_by_address'))
        .map(a => `${a.route} (${got.has(a.route) ? show(got.get(a.route)!.r) : 'not swept'})`);
    /** The routes among `which` whose measured call was not answered as done (2xx), each with its answer. */
    const notDone = (which: string[], got: Map<string, Measured>) => which
        .filter(r => !(got.get(r) && got.get(r)!.r.status >= 200 && got.get(r)!.r.status < 300))
        .map(r => `${r} (${got.has(r) ? show(got.get(r)!.r) : 'not swept'})`);
    /** What is wrong with one write's outcome, if anything, given what this signer may do on that route. */
    const verdict = (route: string, m: Awaited<ReturnType<typeof measure>>, allowed: May | undefined): string | null => {
        const problems: string[] = [];
        if (m.r.status === 500) problems.push('a server error');
        if (!allowed && m.r.status >= 200 && m.r.status < 300) problems.push('answered as done');
        const extra = m.changed.filter(t => t !== 'node_config' && !(allowed?.tables ?? []).includes(t));
        const keys = m.config.map(k => k.slice('node_config.'.length)).filter(k => !(allowed?.config ?? []).includes(k));
        if (keys.length) extra.push(`node_config (${keys.join(', ')})`);
        if (extra.length) problems.push(`changed ${extra.join(', ')}`);
        if (m.left.length && !allowed?.out) problems.push(`sent ${m.left.join(', ')}`);
        return problems.length ? `${route} → ${show(m.r)}: ${problems.join('; ')}` : null;
    };

    // The knocks' tidy runs here, between writes (tidyNow), not on its minute: restarted with a day's period, it never ticks.
    startTidyingKnocks(86_400_000);
    tidyNow();

    // ── 2. a fresh key ───────────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. a fresh key with no row here, one per write ──');
    {
        const wrong: string[] = [];
        const tally: Record<string, number> = {};
        const got = new Map<string, Measured>();
        for (const route of writes) {
            const m = await measure(route, newId());
            tally[m.r.status] = (tally[m.r.status] ?? 0) + 1;
            got.set(route, m);
            const v = verdict(route, m, STRANGER_MAY[route]);
            if (v) wrong.push(v);
        }
        assert(wrong.length === 0, `a fresh key's ${writes.length} writes: each refused one is not answered as done, changes no table, sends `
            + `nothing and is no server error; each it may call changes only its own tables${wrong.length ? `; ${wrong.length} did not:\n    ${wrong.join('\n    ')}` : ''}`);
        console.log(`  (answers by status: ${Object.entries(tally).map(([k, v]) => `${k}×${v}`).join(', ')})`);
        const unanswered = notDone(Object.keys(STRANGER_MAY), got);
        assert(unanswered.length === 0, `each of the ${Object.keys(STRANGER_MAY).length} writes a stranger may call is answered as done: its body reaches `
            + `what the route does, so "changes only its own tables" was measured where it writes${unanswered.length ? ` — not: ${unanswered.join(', ')}` : ''}`);
        const missed = notCounted(ADDRESS_CAPPED.filter(a => a.who === 'stranger'), got);
        assert(missed.length === 0, `its body reaches each write a stranger may make charged to its address, so what those change was measured `
            + `(writes_by_address moved)${missed.length ? ` — not reached: ${missed.join(', ')}` : ''}`);
    }
    {
        // The assistant switch off, as it is until an owner turns assistants on: every write of the door answers 404 before
        // any handler (agent/oauth-route.ts oauthDoorOff), sent by a live request's own browser too (its cookie, its id), and
        // changes nothing: no table, no call out, and not the request's ticks either, which live in memory.
        const page = await openConsent();
        const door = writes.filter(r => r.split(' ')[1].startsWith('/oauth/'));
        tidyNow();
        updateLocalConfig({ aiAssistantsAllowed: false });
        const before = snapshot();
        const sent = outside.length;
        const notOff: string[] = [];
        for (const route of door) {
            const [method, routePath] = route.split(' ') as [Method, string];
            const x = newId();
            resetLimits();
            const r = await call(method, x, routePath.replace(':id', page.id), (BODIES[route] ?? bait)(x), { Cookie: page.cookie });
            if (r.status !== 404) notOff.push(`${route} → ${show(r)}`);
        }
        await settle();
        const changed = changedTables(before, snapshot());
        const left = outside.slice(sent);
        updateLocalConfig({ aiAssistantsAllowed: true });
        resetLimits();
        const ticks = await asksShown(page.id);
        assert(door.length >= 6 && notOff.length === 0 && changed.length === 0 && left.length === 0 && ticks?.canPost === false && ticks?.canModerate === false,
            `the assistant switch off: each of the door's ${door.length} writes (${door.join(', ')}) answers 404, from the page's own browser too, `
            + `and nothing changes (the phone is still shown ${JSON.stringify(ticks)})${notOff.length ? ` — not 404: ${notOff.join('; ')}` : ''}`
            + `${changed.length ? `; changed: ${changed.join(', ')}` : ''}${left.length ? `; sent: ${left.join(', ')}` : ''}`);
    }

    // ── 3. a key with an open request to join ──────────────────────────────────────────────────────────
    console.log('\n── 3. a key with an open request to join (a knock), one per write ──');
    {
        /** A key that has knocked through the real door, its request open. */
        const knocker = async (): Promise<Id> => {
            const id = newId('KnockerSW');
            resetLimits();
            // Every knock here comes from one address: the knocks' limits a day are not what this suite checks.
            db.prepare('UPDATE join_requests SET ip_hash = NULL').run();
            const sent = outside.length;
            const r = await call('POST', id, '/api/join/knock', { callsign: 'Knocker SW', message: 'I would like to join, please.' });
            if (r.status !== 201) throw new Error(`a knock was answered ${show(r)}`);
            // Every knock tells the owners (a bell and a push): settled before the write is measured, so it is not the write's.
            for (let waited = 0; outside.length === sent && waited < 2000; waited += 10) await settle(10);
            await settle(30);
            // Its bell put each owner one over the notices a member keeps: trimmed now, so the hygiene timer's trim (every
            // few minutes, state-engine.ts) never lands inside the write's window as a change to push_notices.
            tidyNow();
            return id;
        };
        const wrong: string[] = [];
        const got = new Map<string, Measured>();
        for (const route of writes) {
            const id = await knocker();
            const m = await measure(route, id);
            got.set(route, m);
            const v = verdict(route, m, KNOCKER_MAY[route] ?? STRANGER_MAY[route]);
            if (v) wrong.push(v);
            // Its request goes once measured, so the node's limit on open requests is never what answers the next one, and
            // with it (tidied now) its phone and browser, and the owners' oldest bells.
            db.prepare('DELETE FROM join_requests WHERE pubkey = ?').run(id.pk);
            tidyNow();
        }
        assert(wrong.length === 0, `a knocking key's ${writes.length} writes: the same, with its own request, phone and browser added`
            + `${wrong.length ? `; ${wrong.length} did not:\n    ${wrong.join('\n    ')}` : ''}`);
        // Asking again while its request is open is answered as the request stands (409 knock_open), and changes nothing.
        const again = 'POST /api/join/knock';
        const mayCall = [...new Set([...Object.keys(STRANGER_MAY), ...Object.keys(KNOCKER_MAY)])].filter(r => r !== again);
        const unanswered = notDone(mayCall, got);
        assert(unanswered.length === 0 && got.get(again)?.r.body?.code === 'knock_open', `each of the ${mayCall.length} other writes it may call is `
            + `answered as done, so what they change was measured where they write, and asking again is told its request is open `
            + `(${got.has(again) ? show(got.get(again)!.r) : 'not swept'})${unanswered.length ? ` — not: ${unanswered.join(', ')}` : ''}`);
        const missed = notCounted(ADDRESS_CAPPED, got);
        assert(missed.length === 0, `its body reaches each of the ${ADDRESS_CAPPED.length} writes charged to its address (its phone among them), so what `
            + `those change was measured (writes_by_address moved)${missed.length ? ` — not reached: ${missed.join(', ')}` : ''}`);
        const kimStill = db.prepare('SELECT status FROM join_requests WHERE id = ?').get(kimKnockId) as { status: string } | undefined;
        assert(kimStill?.status === 'pending', `Kim's request to join is still waiting for a member's answer (${kimStill?.status})`);
    }

    // ── 4. the live socket ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. the live socket ──');
    {
        // The socket reads one message, the heartbeat's ping (https-server.ts trackConnection), and writes nothing for it.
        // Every frame a write would be, from a socket signed by a stranger's key and from one unsigned, changes nothing.
        const frames = ['{"type":"ping","wantPong":true}', '{"type":"ping"}', JSON.stringify({ type: 'post_updated', id: aliceOffer.id }),
            JSON.stringify({ type: 'send', conversationId: dm.id, ...lockedDm() }), JSON.stringify({ type: 'transfer', to: alice.pk, amount_c: 100 }), 'not json'];
        tidyNow();
        const before = snapshot();
        const sent = outside.length;
        let pongs = 0;
        for (const signed of [true, false]) {
            const id = newId();
            const ts = Date.now();
            const nonce = crypto.randomBytes(16).toString('hex');
            const q = signed ? `?pubkey=${id.pk}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(signSocket(id.priv, ts, nonce))}&${socketBinding()}` : '';
            const ws = new WebSocket(`wss://localhost:${port}/ws${q}`, { rejectUnauthorized: false });
            await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
            ws.on('message', (d) => { if (String(d).includes('pong')) pongs++; });
            for (const f of frames) ws.send(f);
            await settle(150);
            ws.close();
        }
        await settle(50);
        const changed = changedTables(before, snapshot());
        assert(changed.length === 0 && outside.length === sent && pongs >= 1,
            `a socket signed by a stranger's key, and one unsigned, send every frame a write would be: nothing changes and nothing leaves `
            + `(the ping answered ${pongs} times${changed.length ? `; changed: ${changed.join(', ')}` : ''})`);
    }

    // ── 5. controls: the sweep can fail ──────────────────────────────────────────────────────────────
    console.log('\n── 5. controls ──');
    {
        // The same bodies and paths, signed by Alice (the owner whose offer, event, poll, group, enterprise, crowdfund, topic and
        // page they name, Kim's request among them), change what the sweep watches on many writes, her own activity stamp
        // left out: the bodies reach real data, so a stranger's "nothing changed" is a refusal, not a body that missed.
        // One pass, in route order, so a write early in it can leave a later one nothing to do: the count is a floor.
        const reached: string[] = [];
        const aliceGot = new Map<string, string>();
        for (const route of writes) {
            if (route === 'POST /api/member/purge') continue; // Alice stays a member for the rest of this control
            const m = await measure(route, alice, true);
            if (m.changed.length || m.left.length) reached.push(route);
            else aliceGot.set(route, show(m.r));
        }
        console.log(`  (Alice's same body changed something or called out on ${reached.length} writes, `
            + `${reached.filter(r => STRANGER_REFUSED.has(r)).length} of them refused to a stranger: ${reached.join(', ')})`);
        // 59 when this suite was written, 76 once OWN_STATE had its bodies, 78 once the price report and the leave statement had
        // theirs (18 Nov 2026); the floor leaves room for routes that change, not for bodies that miss.
        assert(reached.length >= 45, `the member the bodies name, signing them, changes something on ${reached.length} of the ${writes.length} writes `
            + '(at least 45): the bodies reach real data');
        for (const must of ['POST /api/marketplace/posts/pause', 'POST /api/marketplace/posts/resume', 'POST /api/marketplace/posts/update',
            'POST /api/groups/:id/chat/message', 'POST /api/groups/:id/chat/remove', 'POST /api/marketplace/posts/:id/chat/remove',
            'POST /api/join/knocks/:id/approve', 'POST /api/marketplace/polls/vote', 'POST /api/knowledge/posts', 'DELETE /api/groups/:id/posts/:postId',
            'POST /api/marketplace/posts/copies/confirm']) {
            assert(reached.includes(must), `among them ${must}, which the stranger sweeps sent the same body to`);
        }
        // The class where review found two holes (a stranger's push switches, the node's TikTok relay) and a write in the wrong
        // list (the funnel count): a write that keeps the signer's own things, where BAIT never reached the write. Each such write has a body
        // here that does, so Alice's same body changes something, or it says why it can't.
        const ownUnserved = Object.keys(OWN_STATE).filter(r => !STRANGER_REFUSED.has(r));
        assert(ownUnserved.length === 0, `every write listed as keeping the signer's own things is one a stranger is refused${ownUnserved.length ? ` — not: ${ownUnserved.join(', ')}` : ''}`);
        const ownMissed = Object.entries(OWN_STATE).filter(([r, why]) => why === REACHED && !reached.includes(r)).map(([r]) => r);
        const ownReached = Object.values(OWN_STATE).filter(why => why === REACHED).length;
        assert(ownMissed.length === 0, `each of the ${ownReached} writes that keep the signer's own things and are reached here changed something for Alice, `
            + `so a stranger's "nothing changed" on them is a refusal (${Object.keys(OWN_STATE).length - ownReached} more say why they can't be)`
            + `${ownMissed.length ? ` — not reached: ${ownMissed.map(r => `${r} (Alice: ${aliceGot.get(r)})`).join(', ')}` : ''}`);
        const saidNot = Object.entries(OWN_STATE).filter(([r, why]) => why !== REACHED && reached.includes(r)).map(([r]) => r);
        assert(saidNot.length === 0, `and none listed with why it can't be reached is reached after all, so the list says what the control does`
            + `${saidNot.length ? ` — reached: ${saidNot.join(', ')}` : ''}`);
        // And the snapshot sees a stranger's row: one planted by hand.
        const before = snapshot();
        db.prepare('INSERT INTO friends (owner_pubkey, friend_pubkey) VALUES (?, ?)').run(newId().pk, alice.pk);
        assert(changedTables(before, snapshot()).includes('friends'), 'a row a stranger added would be seen: the snapshot names its table');
        // The consent page's ticks live in memory, not in a table, so the snapshot alone can't tell a refusal from a body
        // that missed. The sweep's body, sent by the request's own browser (its cookie), reaches the write: the phone is
        // shown both ticks. The same body signed by a stranger without the cookie is refused (403) and moves none.
        const page = await openConsent();
        const ticksBody = BODIES['POST /oauth/authorize/:id/asks'](newId());
        resetLimits();
        const stranger = await call('POST', newId(), `/oauth/authorize/${page.id}/asks`, ticksBody);
        const afterStranger = await asksShown(page.id);
        const own = await call('POST', null, `/oauth/authorize/${page.id}/asks`, ticksBody, { Cookie: page.cookie });
        const afterOwn = await asksShown(page.id);
        assert(stranger.status === 403 && stranger.body?.status === 'wrong-browser' && afterStranger?.canPost === false && afterStranger?.canModerate === false
            && own.status === 200 && afterOwn?.canPost === true && afterOwn?.canModerate === true,
            `a consent page's ticks: a stranger's signed body without the page's cookie is refused and the phone is shown none (${show(stranger)}; `
            + `${JSON.stringify(afterStranger)}); the page's own browser, the same body, sets both (${show(own)}; ${JSON.stringify(afterOwn)})`);
    }

    globalThis.setTimeout = realSetTimeout;
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
