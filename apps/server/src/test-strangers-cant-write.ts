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
 *      entry the node no longer serves fails too.
 *   2. A fresh key. Each write, signed by a key made for that one request (so no per-key limit or spent nonce answers in
 *      its place), with a body that reaches members' things (Alice's offer, event, poll, group, chat lines, trade,
 *      enterprise, crowdfund, Commons decision and project, forum topic, Local knowledge page, invite code, DM; Kim's
 *      request to join) and names the signer wherever a route takes the actor from the body. A refused write is answered
 *      neither as done (2xx) nor with a server error (500), changes no table (every row of every table, hashed, before and
 *      after; node_config key by key; only the BOOKKEEPING ones below are left out, each named with why) and sends nothing
 *      out (no Expo push, no web push, no call to any outside host; mail for another community is a table, so it is
 *      watched with the rest). A STRANGER_MAY write changes only its named tables, and sends out only where it says so.
 *   3. A key with an open request to join (a knock, the door every stranger may use): the same sweep, each key knocking
 *      first through the real door. A knock is no membership: it may act on its own request, phone and browser, and
 *      nothing else; Kim's request is still waiting at the end.
 *   4. The live socket: it reads one message, the heartbeat's ping. A socket signed by a stranger's key, and one unsigned,
 *      send every frame a write would be: nothing changes and nothing leaves.
 *   5. Controls, so the sweep can fail: the same bodies signed by Bob, a member, change something on many of the writes
 *      (the bodies reach real data, so a stranger's "nothing changed" is a refusal), and a row a stranger planted would be
 *      seen by the same snapshot.
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

import crypto from 'node:crypto';
import WebSocket from 'ws';
import { signRequest, signSocket, socketBinding, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

// ── the lists ───────────────────────────────────────────────────────────────────────────────────────
/** What a stranger's call to a write it may make is allowed to change: these tables, and a call out only when `out` says so. */
interface May { why: string; tables: string[]; out?: string }

/**
 * The writes a key with no row here may call, each with why. Answered (often as done), but changing nothing beyond its own
 * tables. Doors that need a secret this sweep never holds (an invite code's redeem, a claim code, a re-key code, a verified
 * sign-in, a pairing's confirm digits, a replication token) are in STRANGER_REFUSED: without the secret they change nothing.
 */
const STRANGER_MAY: Record<string, May> = {
    'POST /api/join/knock': { why: 'asking to join is the stranger\'s own door: its request, and the owners and admins told someone is asking',
        tables: ['join_requests', 'push_notices', 'node_config'], out: 'a push to the owners and admins who answer requests' },
    'DELETE /api/push-tokens': { why: 'taking the signer\'s own phone off: a key with no row has none, so nothing goes', tables: [] },
    'POST /api/channels/mine': { why: 'the signer\'s own Pulse channels, asked by POST: a key with no row has none', tables: [] },
    'POST /api/member/pulse/nudges': { why: 'the signer\'s own Pulse nudges, asked by POST: a key with no row has none', tables: [] },
    'POST /api/recovery/find-nonce': { why: 'a recovering phone\'s first step (its sign-in nonce, held in memory), before any account is found', tables: [] },
    'POST /api/local/admin/auth/challenge': { why: 'starting a Settings sign-in: a challenge held in memory, which only an owner\'s, admin\'s or moderator\'s signature answers', tables: [] },
    'POST /api/local/admin/auth/pairing': { why: 'starting a Settings sign-in by QR: a pairing held in memory, which only a role-holder\'s phone approves', tables: [] },
    'POST /api/local/admin/auth/logout': { why: 'signing out a session the caller does not have: nothing to end', tables: [] },
    'POST /oauth/revoke': { why: 'an assistant\'s token revoke answers 200 to anything (RFC 7009 §2.2), revoking only a token it is sent', tables: [] },
};

/** What a key with an open request to join may also do, beyond STRANGER_MAY: its own request, its phone and its browser. */
const KNOCKER_MAY: Record<string, May> = {
    'POST /api/join/knock': { why: 'asking again: its open request is answered as it stands', tables: ['join_requests', 'push_notices', 'node_config'],
        out: 'a push to the owners and admins who answer requests' },
    'POST /api/join/knock/cancel': { why: 'taking back its own request', tables: ['join_requests'] },
    'POST /api/push-tokens': { why: 'its phone, so it hears the answer (web push W4: kept only while its request is open), counted against its address\'s day cap',
        tables: ['push_tokens', 'writes_by_address'] },
    'POST /api/web-push': { why: 'its browser, so it hears the answer (web push W1)', tables: ['web_push_subscriptions'] },
    'DELETE /api/web-push': { why: 'taking its own browser off', tables: ['web_push_subscriptions'] },
};

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
    'DELETE /api/treasury/:treasury/thread/message/:messageId', 'DELETE /api/treasury/:treasury/tools/:tool', 'DELETE /api/web-push',
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
    'POST /api/funnel-event', 'POST /api/global/circles/:id/starting', 'POST /api/global/watches', 'POST /api/groups',
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
    'POST /api/local/admin/community-shape/advice', 'POST /api/local/admin/csrf-token', 'POST /api/local/admin/data',
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
    'POST /api/mail/group/confirm', 'POST /api/mail/report', 'POST /api/mail/send', 'POST /api/marketplace/polls/close',
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
    'POST /api/pair/collect', 'POST /api/pair/confirm', 'POST /api/pair/init', 'POST /api/pair/offer', 'POST /api/pair/saved',
    'POST /api/pair/send', 'POST /api/pair/transfer', 'POST /api/peek', 'POST /api/peek/stop', 'POST /api/pricing-guide/admin/aggregate',
    'POST /api/pricing-guide/admin/config', 'POST /api/pricing-guide/admin/item', 'POST /api/pricing-guide/admin/pin',
    'POST /api/pricing-guide/admin/reset', 'POST /api/pricing-guide/report', 'POST /api/pricing-guide/reports/:id/status',
    'POST /api/profile/update', 'POST /api/push-tokens', 'POST /api/push-tokens/leave/:publicKey', 'POST /api/ratings',
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
    'POST /oauth/authorize/:id/confirm', 'POST /oauth/authorize/:id/wait', 'POST /oauth/register', 'POST /oauth/token', 'PUT /api/contacts/copy',
    'PUT /api/enterprise/:treasury/profile', 'PUT /api/events/:postId/reminder', 'PUT /api/marketplace/posts/:id/feature', 'PUT /api/names/copy',
    'PUT /api/names/entries/:id', 'PUT /api/profile/privacy', 'PUT /api/shops/mine', 'PUT /api/tools/:tool',
    'PUT /api/treasury/:treasury/profile', 'PUT /api/treasury/:treasury/shop', 'PUT /api/treasury/:treasury/tools/:tool',
    'PUT /mcp/photos/u/:token',
]);

// ── nothing leaves the node ─────────────────────────────────────────────────────────────────────────
/**
 * Every call the node made to a host that is not this machine: Expo's push service, a browser's push service (web push
 * goes out with the global fetch, services/web-push.ts), another community, anything. Answered here, never sent.
 */
const outside: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    let host = '';
    try { host = new URL(String(url)).hostname; } catch { /* not a URL */ }
    if (host && host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && host !== '[::1]') {
        let to = '';
        if (host === 'exp.host') { try { to = ` (push to ${JSON.parse(String(init?.body ?? '[]')).map((m: any) => m.to).join(', ')})`; } catch { /* not a list */ } }
        outside.push(`${init?.method ?? 'GET'} ${host}${to}`);
        return new Response(host === 'exp.host' ? '{"data":[]}' : '{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
}) as typeof fetch;

// ── identities and requests ─────────────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name = 'Stranger'): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}

let BASE = '';
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
interface Res { status: number; body: any; text: string }
async function call(method: Method, id: Id | null, urlPath: string, body?: unknown): Promise<Res> {
    const bodiless = method === 'GET';
    const raw = bodiless ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
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
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    const { resetChatRateLimit } = await import('./chat-rate-limit.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');
    const { resetPasswordBrake } = await import('./password-brake.js');
    const { resetClaimBrake } = await import('./claim-code.js');
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
    };
    const unservedBodies = Object.keys(BODIES).filter(r => !writes.includes(r));
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
    /** Every table's row count and a hash of every row, but the bookkeeping ones; node_config key by key. */
    function snapshot(): Map<string, string> {
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
            for (const row of db.prepare(`SELECT * FROM "${name}"`).iterate()) { h.update(JSON.stringify(row)); n++; }
            out.set(name, `${n}:${h.digest('hex')}`);
        }
        return out;
    }
    const differing = (a: Map<string, string>, b: Map<string, string>) => [...new Set([...a.keys(), ...b.keys()])].filter(t => a.get(t) !== b.get(t));
    /** The tables that differ, node_config's keys folded into node_config. */
    const changedTables = (a: Map<string, string>, b: Map<string, string>) =>
        [...new Set(differing(a, b).map(t => t.startsWith('node_config.') ? 'node_config' : t))];

    /** One write, signed by `signer`: its answer, the tables it changed, the node_config keys among them, and what left the node. */
    const measure = async (route: string, signer: Id) => {
        const [method, routePath] = route.split(' ') as [Method, string];
        const body = (BODIES[route] ?? bait)(signer);
        resetLimits();
        const before = snapshot();
        const sent = outside.length;
        const r = await call(method, signer, materialise(routePath), body);
        await settle();
        const after = snapshot();
        return { r, changed: changedTables(before, after), config: differing(before, after).filter(t => t.startsWith('node_config.')), left: outside.slice(sent) };
    };
    /** What is wrong with one write's outcome, if anything, given what this signer may do on that route. */
    const verdict = (route: string, m: Awaited<ReturnType<typeof measure>>, allowed: May | undefined): string | null => {
        const problems: string[] = [];
        if (m.r.status === 500) problems.push('a server error');
        if (!allowed && m.r.status >= 200 && m.r.status < 300) problems.push('answered as done');
        const extra = m.changed.filter(t => !(allowed?.tables ?? []).includes(t));
        if (extra.length) problems.push(`changed ${extra.join(', ')}${m.config.length ? ` (${m.config.join(', ')})` : ''}`);
        if (m.left.length && !allowed?.out) problems.push(`sent ${m.left.join(', ')}`);
        return problems.length ? `${route} → ${show(m.r)}: ${problems.join('; ')}` : null;
    };

    // ── 2. a fresh key ───────────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. a fresh key with no row here, one per write ──');
    {
        const wrong: string[] = [];
        const tally: Record<string, number> = {};
        for (const route of writes) {
            const m = await measure(route, newId());
            tally[m.r.status] = (tally[m.r.status] ?? 0) + 1;
            const v = verdict(route, m, STRANGER_MAY[route]);
            if (v) wrong.push(v);
        }
        assert(wrong.length === 0, `a fresh key's ${writes.length} writes: each refused one is not answered as done, changes no table, sends `
            + `nothing and is no server error; each it may call changes only its own tables${wrong.length ? `; ${wrong.length} did not:\n    ${wrong.join('\n    ')}` : ''}`);
        console.log(`  (answers by status: ${Object.entries(tally).map(([k, v]) => `${k}×${v}`).join(', ')})`);
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
            return id;
        };
        const wrong: string[] = [];
        for (const route of writes) {
            const id = await knocker();
            const m = await measure(route, id);
            const v = verdict(route, m, KNOCKER_MAY[route] ?? STRANGER_MAY[route]);
            if (v) wrong.push(v);
            // Its request goes once measured, so the node's limit on open requests is never what answers the next one.
            db.prepare('DELETE FROM join_requests WHERE pubkey = ?').run(id.pk);
        }
        assert(wrong.length === 0, `a knocking key's ${writes.length} writes: the same, with its own request, phone and browser added`
            + `${wrong.length ? `; ${wrong.length} did not:\n    ${wrong.join('\n    ')}` : ''}`);
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
        // The same bodies, signed by Bob (a member: in Alice's club, a keeper of her enterprise, asking for her offer), change
        // what the sweep watches on many writes: the bodies reach real data, so a stranger's "nothing changed" is a refusal.
        const reached: string[] = [];
        for (const route of writes) {
            if (route === 'POST /api/member/purge') continue; // Bob stays a member for the rest of this control
            const m = await measure(route, bob);
            if (m.changed.length) reached.push(route);
        }
        console.log(`  (a member's same body changed something on ${reached.length} writes: ${reached.join(', ')})`);
        assert(reached.length >= 40, `a member signing the same bodies changes something on ${reached.length} of the ${writes.length} writes `
            + '(at least 40): the bodies reach real data');
        for (const must of ['POST /api/marketplace/posts/pause', 'POST /api/groups/:id/chat/message', 'POST /api/messages/send', 'POST /api/forum/topics/:id/replies']) {
            assert(reached.includes(must), `among them ${must}, which the stranger sweeps sent the same body to`);
        }
        // And the snapshot sees a stranger's row: one planted, in a table no route above wrote.
        const before = snapshot();
        db.prepare('INSERT INTO friends (owner_pubkey, friend_pubkey) VALUES (?, ?)').run(newId().pk, alice.pk);
        assert(changedTables(before, snapshot()).includes('friends'), 'a row a stranger added would be seen: the snapshot names its table');
    }

    globalThis.setTimeout = realSetTimeout;
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
