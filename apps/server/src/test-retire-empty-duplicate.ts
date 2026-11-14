/**
 * Retire an empty duplicate (Marty, 14 Nov 2026: "if I suspend - I don't want to take this to a vote and annoy people voting
 * to suspend an account that was set up in error"; engine/retire-duplicate.ts), and the manager's Freeze reading the node's
 * own state ("sort the freeze to frozen button"). Over HTTPS through the real middleware.
 *
 *   1. The schema, measured: every column that holds a member's key is either in one of EMPTY_RULES' checks or named below
 *      as no activity of the account's, with why. "Holds a member's key" is each foreign key to members AND each TEXT
 *      column whose name says it (MEMBER_KEY_COLUMN: …_pubkey, public_key, …_by, author, keeper, recipient, voter…, sender_key),
 *      since most member columns have no foreign key. A new table must say which; the name rule is what catches a column
 *      with no foreign key, so a member's key under a name it doesn't know (no "pubkey", "_by" or role word) still slips
 *      past: name such a column so it says what it holds.
 *   2. "Empty", a rule at a time: a fresh account may be retired, and so may a convenor in a group another member made
 *      who sent nobody an invitation; then one account per rule, each holding only that one thing, is refused with that
 *      rule's code and words (yourself, an enterprise, the node's own SYSTEM row and a row under another spelling of a
 *      key, a suspended account, a role, a balance, a post, a group invitation sent as a convenor, waiting or accepted, a
 *      payment, a message sent, mail sent to another community, credit, an enterprise kept, someone brought in, a report,
 *      a forum topic started, a forum reply written and removed since). Each refusal for what the account did or holds also
 *      says Suspend stays the way. Mail from another community waiting for it, the receipt its device sent back for mail it
 *      got, and being told once that the forum is public leave it empty.
 *   3. Who: an owner's own key session only. An admin is refused, an owner's automation token is refused; a refused
 *      retire writes nothing.
 *   4. The retire: 200, no vote or decision opened, nothing deleted (the row and its account stay); 'disabled' with
 *      retired_at and retired_by (the owner); the key's signed requests are refused (account_retired); the member
 *      directory and the community's member count leave it out; the owners' list keeps it, marked retiredAt; Lift
 *      suspension is refused (use Bring back); retiring it again is refused (not active).
 *   5. Bring back: active again, the mark cleared, its key signs again, and it is back in the directory and the count.
 *   5b. Made active another way (what a passed unsuspend or reinstate vote runs, setUserStatusRow 'active'): the mark is
 *      cleared, with a tombstone, so an admin's later pause is a pause: its key and the owners' list read it as paused, not
 *      retired; Bring back refuses it (not retired) and leaves the pause and its remove_member vote standing; Lift lifts
 *      it and closes that vote.
 *   6. Freeze: the owners' member rows carry creditFrozen as the node holds it, after a freeze and after an unfreeze.
 *   7. A standby: retired_accounts is a plain table (copied, Bring back's delete a tombstone), a re-key moves it, and a
 *      standby retires nothing (409 standby).
 *
 * Run: SERVER_SUITES_ONLY=test-retire-empty-duplicate TEST_ALL_JOBS=2 node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, setUserStatusRow, inviteGroupMember, joinGroup } from './state-engine.js';
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { ownerTokenHeaders } from './admin-auth-test-harness.js';
import { mintHandshakeToken, consumeHandshakeToken } from './admin-key-auth.js';
import { grantNodeRole } from './engine/node-roles.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { db } from './db/db.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';
import { setNodeRole } from './config/node-role.js';
import { EMPTY_RULES, RETIRE_WORDS } from './engine/retire-duplicate.js';
import { TABLES } from './engine/replication-manifest.js';
import { markForumTold } from './engine/forum.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';
type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 240)}`;

/**
 * Every column holding a member's key that is no activity of the account itself, and why: what was done to it, its own
 * settings and reading, and throwaway keys. Anything else must be in EMPTY_RULES (anything it did, its acts as an owner,
 * admin or moderator too).
 */
const NOT_ACTIVITY: Record<string, string> = {
    'invite_codes.used_by': 'the code it joined with: every account has one',
    'push_tokens.public_key': "its phone's push address: no act",
    'member_preferences.public_key': 'its own settings: no act',
    'recovery_shares.owner_pubkey': 'its own 12-word recovery copies: no act',
    'recovery_collections.owner_pubkey': 'a restore of its own account: no act',
    'open_joins.member_pubkey': 'how it joined (the open door): every such account has one',
    'place_watches.pubkey': 'places it watches for news: its own reading, no act',
    'conversation_participants.public_key': 'a conversation someone else may have added it to; what it SENT is `messages`',
    'conversations.created_by': 'a conversation opened, with nothing sent: what it sent is `messages`',
    'friends.owner_pubkey': "its own contacts list: nobody else's record",
    'friends.friend_pubkey': 'someone else added it as a friend: not its act',
    'event_reminders_sent.member_pubkey': 'a reminder the server sent it: not its act (going is event_rsvps, `posts`)',
    'owner_words_checks.member_pubkey': "an owner's 12-word check: only a role holder has one (`holds_role`)",
    'owner_lock_opens.member_pubkey': "an owner's lock: only a role holder has one (`holds_role`)",
    'decision_electors.member_pubkey': 'a jury it was drawn into: not its act (a vote it cast is `votes`)',
    'group_members.member_pubkey': 'a group someone added it to: a group it made is `posts`',
    'federation_links.treasury_pubkey': "a link's treasury: an enterprise row, never a person's (`not_person`)",
    'federation_link_treasuries.treasury_pubkey': "a link's treasury: an enterprise row, never a person's (`not_person`)",
    'group_invite_declines.invitee_pubkey': 'a group invitation someone else sent it, declined: not its act on anyone',
    'chat_mutes.member_pubkey': 'chats it muted: its own setting',
    'thread_read_cursors.member_pubkey': 'how far it read a thread: its own reading',
    'member_tool_state.public_key': "its own tools' settings",
    'member_photos.public_key': 'its own profile photo: no act on anyone',
    'accounts.public_key': 'its own account row: the balance rule reads it (`balance`)',
    'photo_url_heals.viewer': 'its app refreshing listing-photo links: its own reading',
    'push_token_leaves.public_key': 'its phone leaving pushes: its own setting',
    'web_push_subscriptions.public_key': "its browser's push address: no act",
    'photo_budget_log.member_pubkey': "photo bytes it stored in a day: a post's photo is the post (`posts`), its own photo no act",
    'recovery_shares.ephemeral_pubkey': "a throwaway key, never a member's",
    'recovery_collections.requester_ephemeral_pubkey': "a throwaway key, never a member's",
    'recovery_releases.ephemeral_pubkey': "a throwaway key, never a member's",
    'names_shares.ephemeral_pubkey': "a throwaway key, never a member's",
    'names_copies.ephemeral_pubkey': "a throwaway key, never a member's",
    'recovery_releases.owner_pubkey': 'a piece released for a restore of its own account: no act (releasing one for someone else is `invited`)',
    'burst_actions.anchor_pubkey': "the moderators' clean-up of a burst of joins opened from it: done to it, not by it",
    'join_requests.pubkey': 'its own request to join: how it came in',
    'moderation_notices.recipient': 'a notice the moderators sent it: not its act',
    'push_notices.recipient': 'a notice sent to it: not its act',
    'member_blocks.owner_pubkey': 'its own block list: its own setting',
    'member_blocks.blocked_pubkey': 'someone else blocked it: not its act',
    'withheld_conversations.other_pubkey': "the member who blocked a sender: not its act (the sender's is `messages`)",
    'dm_requests.to_pubkey': 'someone asked to message it: not its act (answering is `messages`)',
    'contact_copies.owner_pubkey': 'its own locked contacts list: its own setting',
    'health_access_log.subject_pubkey': 'an admin looked at it: not its act',
    'credit_look_log.subject_pubkey': 'a giver looked at its credit: not its act',
    'names_access_log.subject_pubkey': 'an admin acted on its names-list entry: not its act (a confirmation is `names_list`)',
    'known_consent_log.member_pubkey': 'its own consent to be known: its own setting',
    'retired_accounts.member_pubkey': "the retire's own mark: what this check is for",
    'member_badges.member_pubkey': 'a badge an owner set on it: not its act',
    'activity_feed.actor_pubkey': "the community feed's line of an act its own table holds (each counted there), or a joiner's member_joined line",
    'activity_feed.target_pubkey': "the community feed's line of an act its own table holds (each counted there)",
    'group_key_epochs.created_by': "its phone making a group chat's key at a membership change: as a member (group_members); what it sent is `messages`",
    'group_key_epochs.subject_pubkey': 'the member a group key change was for: membership (group_members)',
    'group_key_wraps.recipient_pubkey': "a group chat's key sealed for it: membership (group_members)",
    'group_key_wraps.wrapper_pubkey': "its phone sealing a group chat's key for a member: as a member (group_members)",
    'rekey_requests.old_pubkey': "its own key's replacement: the account moving, no act",
    'rekey_requests.new_pubkey': "its own key's replacement: the account moving, no act",
    'rekey_proposals.new_pubkey': "its own key's replacement: the account moving, no act",
    'rekey_audit_log.old_pubkey': "its own key's replacement: the account moving, no act",
    'rekey_audit_log.new_pubkey': "its own key's replacement: the account moving, no act",
    'community_copies.owner_pubkey': 'its own sealed key and 12 words: no act',
    'bring_back_log.member_pubkey': 'its own account brought back to a new phone by an admin: no act',
    // Messages across communities (X2, engine/relay-mail.ts, engine/relay-outbox.ts). Mail it SENT is relay_outbox.sender_key (`messages`).
    'relay_mail.recipient': 'mail from another community waiting for it: done to it, not its act',
    'relay_mail.sender_key': "the sender, in another community, of mail waiting here: their key, no act of anyone's here",
    'relay_mail_seen.sender_key': "the sender, in another community, of an item that came here: their key, no act of anyone's here",
    'relay_outbox.recipient': 'the person in another community its mail went to (or a receipt went back to): the sending is relay_outbox.sender_key',
    'invalidated_keys.public_key': "a key closed or replaced: the key's state, no act",
    // The forum (engine/forum.ts). A topic it started or a post or reply it wrote is forum_topics/forum_posts.writer_pubkey (`posts`).
    'forum_members.member_pubkey': 'told once that the forum is public: its own reading, no act (what it wrote is `posts`)',
    'forum_topics.closed_by': "how a topic closed, a word ('writer', 'moderator', 'quiet', 'removed'), never a key",
    'forum_posts.removed_by': "who removed a post, a word ('writer', 'moderator', 'account'), never a key",
    // The forum's notices (engine/forum-notices.ts, F5): following a topic is reading, not writing (what it wrote is `posts`).
    'forum_follows.member_pubkey': 'a topic it follows or muted, and how far it read: its own setting',
};

/**
 * A TEXT column whose name says it holds a member's key (see §1). Read with each foreign key to members; INTEGER and REAL
 * columns (flags and counts such as agent_takedowns.by_author) are no key. A role word may end in `_key` (relay_outbox.sender_key,
 * the mailbox between communities): a name like storage_key or pref_key has no role word, so stays out.
 */
const MEMBER_KEY_COLUMN = /^(?:pubkey|(?:[a-z_]*_)?(?:pubkey|public_key|account|actor|author|owner|member|voter|rater|reporter|target|recipient|keeper|enterprise|subject|holder|sender|payer|payee|buyer|seller|candidate|proposer|creator|lead|convenor|inviter|invitee|viewer)(?:_key)?|[a-z_]*_by)$/;

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey, name };
}

let seq = 0;
function makeMember(name: string, opts: { treasury?: boolean } = {}): Id {
    const id = keypair(`${name}${++seq}`);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_treasury)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'TEST', 'active', ?)`).run(id.pk, id.name, opts.treasury ? 1 : 0);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
    return id;
}

/** A group led by `convenor` and a lead-convenor election in it, proposed by `proposer` for `candidate`; its id. */
function convenorElection(proposer: string, candidate: string, convenor = proposer): string {
    const tag = crypto.randomBytes(6).toString('hex');
    db.prepare(`INSERT INTO groups (id, name, slug, created_by, lead_pubkey) VALUES (?, 'A circle', ?, ?, ?)`).run(`g-${tag}`, `circle-${tag}`, convenor, convenor);
    db.prepare(`INSERT INTO group_convenor_proposals (id, group_id, convenor_pubkey, candidate_pubkey, proposer_pubkey, deadline_at)
                VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+7 days'))`).run(`gp-${tag}`, `g-${tag}`, convenor, candidate, proposer);
    return `gp-${tag}`;
}

/** A group `lead` made and leads, with `convenor` a second convenor in it; its id. */
function groupWithConvenor(lead: string, convenor: string): string {
    const tag = crypto.randomBytes(6).toString('hex');
    db.prepare(`INSERT INTO groups (id, name, slug, created_by, lead_pubkey) VALUES (?, 'A circle', ?, ?, ?)`).run(`g-${tag}`, `circle-${tag}`, lead, lead);
    const add = db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status) VALUES (?, ?, 'convenor', 'active')`);
    add.run(`g-${tag}`, lead);
    add.run(`g-${tag}`, convenor);
    return `g-${tag}`;
}

/** An item `sender` here sent to `far`, a key in another community, as the outbox keeps it once that server took it (engine/relay-outbox.ts). */
function relayOutboxFrom(sender: string, far: string, kind: 'dm-line' | 'receipt'): void {
    const now = Date.now();
    db.prepare(`INSERT INTO relay_outbox (sender_key, item_id, kind, recipient, recipient_home, state, item, attempts, next_try_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'far.example', 'sent', NULL, 1, NULL, ?, ?)`).run(sender, crypto.randomBytes(8).toString('hex'), kind, far, now, now);
}

/** A forum topic `writer` started, its opening post theirs too (engine/forum.ts startTopic's rows); its id. */
function forumTopicBy(writer: string): string {
    const tag = crypto.randomBytes(6).toString('hex');
    const at = new Date().toISOString();
    db.prepare(`INSERT INTO forum_topics (id, section_id, title, writer_pubkey, reply_count, last_activity_at, created_at)
                VALUES (?, 'fs-test', 'Who has a ladder?', ?, 0, ?, ?)`).run(`ft-${tag}`, writer, at, at);
    db.prepare(`INSERT INTO forum_posts (id, topic_id, number, writer_pubkey, words, created_at) VALUES (?, ?, 1, ?, 'Mine broke.', ?)`)
        .run(`fp-${tag}`, `ft-${tag}`, writer, at);
    return `ft-${tag}`;
}

/** A line `far`, in another community, sent to `recipient` here, waiting for their device (engine/relay-mail.ts). */
function relayMailFor(recipient: string, far: string): void {
    db.prepare(`INSERT INTO relay_mail (sender_key, item_id, kind, recipient, sender_home, envelope, payload, bytes, received_at)
                VALUES (?, ?, 'dm-line', ?, 'far.example', '{}', 'sealed', 6, ?)`).run(far, crypto.randomBytes(8).toString('hex'), recipient, Date.now());
}

function resetLimits(): void {
    resetGatewayRateLimit();
    resetAdminRateLimit();
    resetAdminAuthTarpit();
    pruneAuthAttempts(Date.now() + 120_000);
}

async function call(method: string, id: Id | null, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    resetLimits();
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { ...extra };
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = signRequest(id.priv, { method, path: path.split('?')[0], timestamp: ts, nonce, body: bodyString });
        headers[SIGNED_FOR_HEADER] = signedForHost();
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? bodyString : undefined });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

function sessionHeaders(pub: string, role: 'owner' | 'admin'): Record<string, string> {
    const { handshakeToken } = mintHandshakeToken(pub, role);
    const s = consumeHandshakeToken(handshakeToken);
    if (!s.ok || !s.sessionId) throw new Error(`could not open a test key session: ${s.error}`);
    return { 'X-Admin-Session': s.sessionId };
}

const rowOf = (who: Id) => db.prepare(`SELECT m.status, r.retired_at, r.retired_by, m.credit_frozen FROM members m
    LEFT JOIN retired_accounts r ON r.member_pubkey = m.public_key WHERE m.public_key = ?`).get(who.pk) as
    { status: string; retired_at: string | null; retired_by: string | null; credit_frozen: number } | undefined;
const decisionCount = () => db.prepare('SELECT COUNT(*) FROM decisions').pluck().get() as number;

async function adminRow(owner: Record<string, string>, who: Id): Promise<any> {
    const page = await call('POST', null, '/api/local/admin/data/members', { q: who.pk, limit: 5 }, owner);
    return (page.body?.members ?? []).find((m: any) => m.publicKey === who.pk);
}

async function main(): Promise<void> {
    console.log('Retire an empty duplicate, and Freeze reads the node\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const founder = keypair('Founder');
    seedGenesisMember(founder.pk, founder.name);
    const owner = sessionHeaders(founder.pk, 'owner');
    const ada = makeMember('Ada');
    // Granted by the founder, not 'SYSTEM': the node's own row stays as a fresh node has it (nothing done under it), as §2 needs.
    grantNodeRole(ada.pk, 'admin', founder.pk);
    const adaAdmin = sessionHeaders(ada.pk, 'admin');
    const reader = makeMember('Reader');

    // ── 1. The schema, measured ──
    console.log('── 1. Every column naming a member is a rule or named as no activity ──');
    const ruled = new Set(EMPTY_RULES.flatMap(r => r.checks.flatMap(c => c.columns.map(col => `${c.table}.${col}`))));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").pluck().all() as string[];
    const memberColumns = new Set<string>();
    const byForeignKey = new Set<string>();
    for (const t of tables) {
        for (const fk of db.prepare(`SELECT "table" AS ref, "from" AS col FROM pragma_foreign_key_list(?)`).all(t) as Array<{ ref: string; col: string }>) {
            if (fk.ref === 'members') { memberColumns.add(`${t}.${fk.col}`); byForeignKey.add(`${t}.${fk.col}`); }
        }
        for (const c of db.prepare('SELECT name, upper(type) AS type FROM pragma_table_info(?)').all(t) as Array<{ name: string; type: string }>) {
            if (MEMBER_KEY_COLUMN.test(c.name) && !/INT|REAL/.test(c.type)) memberColumns.add(`${t}.${c.name}`);
        }
    }
    const unclassified = [...memberColumns].filter(name => !ruled.has(name) && !(name in NOT_ACTIVITY));
    assert(memberColumns.size > 150 && byForeignKey.size > 0 && memberColumns.size > 2 * byForeignKey.size,
        `the schema check sees member columns with and without a foreign key (${memberColumns.size}, ${byForeignKey.size} of them by foreign key)`);
    assert(unclassified.length === 0, `every column holding a member's key is a rule or named as no activity (unclassified: ${unclassified.join(', ') || 'none'})`);
    // The name rule finds the columns the review found with no foreign key (convenor elections, a guide page sent, a
    // names-list confirmation) and the merge queue's find (mail sent to another community, #3127), so a table like them
    // can't slip past again.
    const noForeignKey = ['group_convenor_proposals.proposer_pubkey', 'group_convenor_proposals.candidate_pubkey', 'group_convenor_votes.voter_pubkey',
        'knowledge_drafts.member_pubkey', 'confirmations.member_pubkey', 'relay_outbox.sender_key'];
    const unseen = noForeignKey.filter(c => byForeignKey.has(c) || !memberColumns.has(c) || !ruled.has(c));
    assert(unseen.length === 0, `columns with no foreign key are seen by name and ruled (not: ${unseen.join(', ') || 'none'})`);
    const both = Object.keys(NOT_ACTIVITY).filter(c => ruled.has(c));
    const stale = Object.keys(NOT_ACTIVITY).filter(c => !memberColumns.has(c));
    assert(both.length === 0 && stale.length === 0, `no column is both a rule and no activity, and each one named is still a member column (both: ${both.join(', ') || 'none'}; not: ${stale.join(', ') || 'none'})`);
    const missing = EMPTY_RULES.flatMap(r => r.checks).filter(c => {
        const cols = new Set(db.prepare('SELECT name FROM pragma_table_info(?)').pluck().all(c.table) as string[]);
        return cols.size === 0 || c.columns.some(col => !cols.has(col));
    }).map(c => `${c.table}(${c.columns.join(',')})`);
    assert(missing.length === 0, `every table and column a rule reads is in the schema (missing: ${missing.join(', ') || 'none'})`);

    // ── 2. "Empty", a rule at a time ──
    console.log('\n── 2. Empty, a rule at a time ──');
    const fresh = makeMember('Fresh');
    const ok = await call('GET', null, `/api/local/admin/users/${fresh.pk}/retire`, undefined, owner);
    assert(ok.status === 200 && ok.body?.allowed === true, `a fresh account with nothing in it may be retired (${show(ok)})`);
    // Being made a convenor in someone else's group is done to it (group_members.member_pubkey): no act until it invites.
    const helper = makeMember('Helper');
    groupWithConvenor(reader.pk, helper.pk);
    const helperOk = await call('GET', null, `/api/local/admin/users/${helper.pk}/retire`, undefined, owner);
    assert(helperOk.status === 200 && helperOk.body?.allowed === true,
        `a convenor in a group another member made, who invited nobody, may be retired (${show(helperOk)})`);
    // Mail from another community waiting for it, and the receipt its device sent back for mail it got: done to it, and its
    // own reading (engine/relay-mail.ts; relay-outbox.ts counts no receipt as writing to anyone either).
    const mailed = makeMember('Mailed');
    const far = keypair('Far').pk;
    relayMailFor(mailed.pk, far);
    relayOutboxFrom(mailed.pk, far, 'receipt');
    const mailedOk = await call('GET', null, `/api/local/admin/users/${mailed.pk}/retire`, undefined, owner);
    assert(mailedOk.status === 200 && mailedOk.body?.allowed === true,
        `mail from another community waiting for it, and its receipt for mail it got, leave it empty (${show(mailedOk)})`);
    // Told once that the forum is public (forum_members, its own reading), in a forum where another member's topic was closed by
    // a moderator and a reply removed (closed_by and removed_by hold a word, no key): nothing it wrote.
    const told = makeMember('Told');
    markForumTold(told.pk);
    const othersTopic = forumTopicBy(reader.pk);
    db.prepare("UPDATE forum_topics SET closed_at = ?, closed_by = 'moderator' WHERE id = ?").run(new Date().toISOString(), othersTopic);
    const toldRow = db.prepare('SELECT told_public_at FROM forum_members WHERE member_pubkey = ?').get(told.pk) as { told_public_at: string | null } | undefined;
    const toldOk = await call('GET', null, `/api/local/admin/users/${told.pk}/retire`, undefined, owner);
    assert(!!toldRow?.told_public_at && toldOk.status === 200 && toldOk.body?.allowed === true,
        `told that the forum is public, with nothing written in it, leaves it empty (${show(toldOk)})`);

    const cases: Array<{ rule: string; label?: string; make: () => Id }> = [
        { rule: 'own_account', make: () => founder },
        { rule: 'not_person', make: () => makeMember('Shop', { treasury: true }) },
        // The review's finds on 8ea9647a: the node's own row passed as a person (on a fresh node it read as empty: allowed,
        // and POST 200), and so would a row a door stored under another spelling of a key.
        { rule: 'not_person', label: "the node's own SYSTEM row", make: () => ({ ...keypair('System'), pk: 'SYSTEM' }) },
        { rule: 'not_person', label: 'a row under another spelling of a key', make: () => {
            const caps = keypair('Caps');
            const pk = caps.pk.toUpperCase();
            db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                        VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'TEST', 'active')`).run(pk, caps.name);
            return { ...caps, pk };
        } },
        { rule: 'not_active', make: () => { const m = makeMember('Paused'); db.prepare("UPDATE members SET status = 'disabled' WHERE public_key = ?").run(m.pk); return m; } },
        { rule: 'holds_role', make: () => { const m = makeMember('Mod'); grantNodeRole(m.pk, 'moderator', 'SYSTEM'); return m; } },
        { rule: 'balance', make: () => { const m = makeMember('Rich'); db.prepare('UPDATE accounts SET balance_c = 500 WHERE public_key = ?').run(m.pk); return m; } },
        { rule: 'posts', make: () => {
            const m = makeMember('Poster');
            db.prepare(`INSERT INTO posts (id, type, category, title, description, author_pubkey) VALUES (?, 'offer', 'other', 'A thing', 'A thing', ?)`).run(`p-${m.pk.slice(0, 8)}`, m.pk);
            return m;
        } },
        // The forum (engine/forum.ts): a topic it started; a reply it wrote in another member's topic, removed since (the row
        // stays as a marker, so remove-and-retire resets nothing, as remove-and-repost resets no daily limit).
        { rule: 'posts', label: 'a forum topic it started', make: () => {
            const m = makeMember('Asker');
            forumTopicBy(m.pk);
            return m;
        } },
        { rule: 'posts', label: "a forum reply it wrote in another member's topic, removed since", make: () => {
            const m = makeMember('Replier');
            const topic = forumTopicBy(reader.pk);
            const at = new Date().toISOString();
            db.prepare(`INSERT INTO forum_posts (id, topic_id, number, writer_pubkey, words, created_at, removed_at, removed_by)
                        VALUES (?, ?, 2, ?, '', ?, ?, 'writer')`).run(`fp-${m.pk.slice(0, 8)}`, topic, m.pk, at, at);
            return m;
        } },
        // The review's find on 8ea9647a: only a declined invitation counted; one waiting or accepted read as empty.
        { rule: 'posts', label: 'a group invitation it sent as a convenor in a group another member made, waiting', make: () => {
            const m = makeMember('Inviting');
            inviteGroupMember(groupWithConvenor(reader.pk, m.pk), m.pk, makeMember('Invitee').pk);
            return m;
        } },
        { rule: 'posts', label: 'a group invitation it sent as a convenor, accepted', make: () => {
            const m = makeMember('Admitting');
            const invitee = makeMember('Invitee');
            const g = groupWithConvenor(reader.pk, m.pk);
            inviteGroupMember(g, m.pk, invitee.pk);
            joinGroup(g, invitee.pk);
            const row = db.prepare('SELECT status, invited_by FROM group_members WHERE group_id = ? AND member_pubkey = ?').get(g, invitee.pk) as any;
            if (row?.status !== 'active' || row?.invited_by !== m.pk) throw new Error(`the invitation was not accepted: ${JSON.stringify(row)}`);
            return m;
        } },
        { rule: 'trades', make: () => {
            const m = makeMember('Payer');
            db.prepare(`INSERT INTO transactions (id, from_pubkey, to_pubkey, amount_c, fee_c) VALUES (?, ?, ?, 100, 0)`).run(`t-${m.pk.slice(0, 8)}`, m.pk, reader.pk);
            return m;
        } },
        { rule: 'messages', make: () => {
            const m = makeMember('Talker');
            const conv = `c-${m.pk.slice(0, 8)}`;
            db.prepare(`INSERT INTO conversations (id, type) VALUES (?, 'dm')`).run(conv);
            db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce) VALUES (?, ?, ?, 'x', 'y')`).run(`m-${m.pk.slice(0, 8)}`, conv, m.pk);
            return m;
        } },
        // Messages across communities (X2, #3127): what it sent another community is in the outbox, not in messages.
        { rule: 'messages', label: 'a line it sent to someone in another community', make: () => {
            const m = makeMember('Writing far');
            relayOutboxFrom(m.pk, keypair('Far').pk, 'dm-line');
            return m;
        } },
        { rule: 'credit', make: () => { const m = makeMember('Granted'); db.prepare('UPDATE members SET earned_credit_c = 10000 WHERE public_key = ?').run(m.pk); return m; } },
        { rule: 'enterprise', make: () => {
            const m = makeMember('Keeper');
            const shop = makeMember('Firm', { treasury: true });
            db.prepare(`INSERT INTO treasury_operators (treasury_pubkey, member_pubkey) VALUES (?, ?)`).run(shop.pk, m.pk);
            return m;
        } },
        { rule: 'invited', make: () => {
            const m = makeMember('Inviter');
            const joiner = makeMember('Joiner');
            db.prepare('UPDATE members SET invited_by = ? WHERE public_key = ?').run(m.pk, joiner.pk);
            return m;
        } },
        { rule: 'votes', make: () => {
            const m = makeMember('Reported');
            db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, reason) VALUES (?, ?, ?, 'spam')`).run(`r-${m.pk.slice(0, 8)}`, reader.pk, m.pk);
            return m;
        } },
        // The review's finds on a67330aa: each of these passed as empty (allowed: true).
        { rule: 'votes', label: "a group's lead-convenor election it proposed and voted yes in", make: () => {
            const m = makeMember('Elector');
            const prop = convenorElection(m.pk, reader.pk, reader.pk);
            db.prepare(`INSERT INTO group_convenor_votes (proposal_id, voter_pubkey, choice) VALUES (?, ?, 'yes')`).run(prop, m.pk);
            return m;
        } },
        { rule: 'votes', label: "a group's lead-convenor election it stood in, nothing more", make: () => {
            const m = makeMember('Candidate');
            convenorElection(reader.pk, m.pk);
            return m;
        } },
        { rule: 'votes', label: "a group's lead-convenor election it only voted in", make: () => {
            const m = makeMember('Voter');
            const prop = convenorElection(reader.pk, reader.pk);
            db.prepare(`INSERT INTO group_convenor_votes (proposal_id, voter_pubkey, choice) VALUES (?, ?, 'no')`).run(prop, m.pk);
            return m;
        } },
        { rule: 'posts', label: 'a guide page it sent, waiting for an admin', make: () => {
            const m = makeMember('Writer');
            db.prepare(`INSERT INTO knowledge_drafts (id, kind, member_pubkey, via, title, body, topic, state, created_at)
                        VALUES (?, 'new', ?, 'app', 'Fixing a tap', 'Turn the water off first.', 'home', 'waiting', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).run(`k-${m.pk.slice(0, 8)}`, m.pk);
            return m;
        } },
        { rule: 'names_list', label: 'confirmed on the names list', make: () => {
            const m = makeMember('Confirmed');
            db.prepare(`INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by) VALUES (?, ?, 'entry-1', ?)`).run(`cf-${m.pk.slice(0, 8)}`, m.pk, founder.pk);
            return m;
        } },
        { rule: 'acted_as_role', label: 'a former admin who changed a community setting', make: () => {
            const m = makeMember('ExAdmin');
            db.prepare(`INSERT INTO community_settings_log (actor_pubkey, actor_role, setting, old_value, new_value) VALUES (?, 'admin', 'posts_per_day', '5', '6')`).run(m.pk);
            return m;
        } },
    ];
    for (const c of cases) {
        const m = c.make();
        const before = JSON.stringify(rowOf(m));
        const check = await call('GET', null, `/api/local/admin/users/${m.pk}/retire`, undefined, owner);
        const tried = await call('POST', null, `/api/local/admin/users/${m.pk}/retire`, {}, owner);
        const own = ['own_account', 'not_person', 'not_active', 'holds_role'].includes(c.rule);
        assert(check.status === 200 && check.body?.allowed === false && check.body?.rule === c.rule
            && tried.status >= 400 && tried.body?.rule === c.rule && typeof tried.body?.error === 'string'
            && (own || tried.body.error.endsWith(RETIRE_WORDS.notEmpty))
            && JSON.stringify(rowOf(m)) === before,
            `${c.rule}${c.label ? ` (${c.label})` : ''}: refused in words, nothing written (${show(tried)})`);
    }

    // ── 3. Who ──
    console.log('\n── 3. An owner, by their own key ──');
    const dup = makeMember('Duplicate');
    const byAdmin = await call('POST', null, `/api/local/admin/users/${dup.pk}/retire`, {}, adaAdmin);
    assert(byAdmin.status === 403 && rowOf(dup)?.status === 'active', `an admin is refused (${show(byAdmin)})`);
    const adminCheck = await call('GET', null, `/api/local/admin/users/${dup.pk}/retire`, undefined, adaAdmin);
    assert(adminCheck.status === 403, `…and an admin's check is refused too, so the manager shows them no button (${adminCheck.status})`);
    const byToken = await call('POST', null, `/api/local/admin/users/${dup.pk}/retire`, {}, ownerTokenHeaders('admin', founder.pk));
    assert(byToken.status === 403 && rowOf(dup)?.status === 'active', `an owner's automation token is refused (${show(byToken)})`);

    // ── 4. The retire ──
    console.log('\n── 4. Retired: no vote, nothing deleted ──');
    const infoBefore = await call('GET', reader, '/api/community/info');
    const decisionsBefore = decisionCount();
    const dirBefore = await call('GET', reader, '/api/members');
    assert(Array.isArray(dirBefore.body) ? dirBefore.body.some((m: any) => (m.publicKey ?? m.public_key) === dup.pk) : JSON.stringify(dirBefore.body).includes(dup.pk),
        'before: the duplicate is in the member directory');
    const done = await call('POST', null, `/api/local/admin/users/${dup.pk}/retire`, {}, owner);
    const row = rowOf(dup);
    assert(done.status === 200 && done.body?.retired === true, `the owner retires it (${show(done)})`);
    assert(row?.status === 'disabled' && !!row.retired_at && row.retired_by === founder.pk, `'disabled', with when and the owner who did it (${JSON.stringify(row)})`);
    assert(decisionCount() === decisionsBefore, `no vote or decision opened (${decisionsBefore} → ${decisionCount()})`);
    assert(!!db.prepare('SELECT 1 FROM accounts WHERE public_key = ?').get(dup.pk), 'nothing deleted: the row and its account stay');
    const signed = await call('GET', dup, '/api/community/info');
    assert(signed.status === 403 && signed.body?.code === 'account_retired' && signed.body?.error === RETIRE_WORDS.signedOut,
        `its key signs in to nothing (${show(signed)})`);
    const dirAfter = await call('GET', reader, '/api/members');
    assert(!JSON.stringify(dirAfter.body).includes(dup.pk), 'it has left the member directory');
    const infoAfter = await call('GET', reader, '/api/community/info');
    const countOf = (r: Res) => r.body?.memberCount ?? r.body?.stats?.memberCount;
    assert(typeof countOf(infoBefore) === 'number' && countOf(infoAfter) === countOf(infoBefore) - 1,
        `the community's member count leaves it out (${countOf(infoBefore)} → ${countOf(infoAfter)})`);
    const listed = await adminRow(owner, dup);
    assert(listed?.status === 'disabled' && typeof listed?.retiredAt === 'string', `the owners' list keeps it, marked retired (${JSON.stringify(listed)?.slice(0, 160)})`);
    const lift = await call('POST', null, `/api/local/admin/users/${dup.pk}/status`, { status: 'active' }, owner);
    assert(lift.status === 409 && lift.body?.code === 'retired' && rowOf(dup)?.status === 'disabled', `Lift suspension is refused: Bring back undoes it (${show(lift)})`);
    const again = await call('POST', null, `/api/local/admin/users/${dup.pk}/retire`, {}, owner);
    assert(again.status === 409 && again.body?.rule === 'not_active', `retiring it again is refused (${show(again)})`);

    // ── 5. Bring back ──
    console.log('\n── 5. Bring back ──');
    const byAdminBack = await call('POST', null, `/api/local/admin/users/${dup.pk}/unretire`, {}, adaAdmin);
    assert(byAdminBack.status === 403 && rowOf(dup)?.status === 'disabled', `an admin can't bring it back (${byAdminBack.status})`);
    const back = await call('POST', null, `/api/local/admin/users/${dup.pk}/unretire`, {}, owner);
    const backRow = rowOf(dup);
    assert(back.status === 200 && backRow?.status === 'active' && backRow.retired_at === null && backRow.retired_by === null,
        `Bring back: active, the mark cleared (${show(back)} ${JSON.stringify(backRow)})`);
    const signsAgain = await call('GET', dup, '/api/community/info');
    assert(signsAgain.status === 200, `its key signs again (${signsAgain.status})`);
    const dirBack = await call('GET', reader, '/api/members');
    assert(JSON.stringify(dirBack.body).includes(dup.pk), 'it is back in the directory');
    const infoBack = await call('GET', reader, '/api/community/info');
    assert(countOf(infoBack) === countOf(infoBefore), `and in the count (${countOf(infoBack)})`);
    const backAgain = await call('POST', null, `/api/local/admin/users/${dup.pk}/unretire`, {}, owner);
    assert(backAgain.status === 409 && backAgain.body?.code === 'not_retired', `bringing back an account that isn't retired is refused (${show(backAgain)})`);

    // ── 5b. Made active another way, then paused ──
    console.log('\n── 5b. Made active by a vote, then paused: a pause, never "retired" ──');
    const twice = makeMember('Twice');
    const retiredTwice = await call('POST', null, `/api/local/admin/users/${twice.pk}/retire`, {}, owner);
    assert(retiredTwice.status === 200 && !!rowOf(twice)?.retired_at, `setup: retired (${show(retiredTwice)})`);
    // What a passed unsuspend or reinstate vote runs (decisions-engine.ts executeDecision).
    setUserStatusRow(twice.pk, 'active');
    const madeActive = rowOf(twice);
    assert(madeActive?.status === 'active' && madeActive.retired_at === null && madeActive.retired_by === null,
        `made active by a vote: the retired mark is cleared (${JSON.stringify(madeActive)})`);
    assert(!!db.prepare("SELECT 1 FROM tombstones WHERE table_name = 'retired_accounts' AND row_key = ?").get(twice.pk),
        '…with a tombstone, so a standby drops it too');
    const paused = await call('POST', null, `/api/local/admin/users/${twice.pk}/suspend`, { reason: 'Posting the same offer again and again in the market' }, adaAdmin);
    const pauseVote = db.prepare(`SELECT id, status FROM decisions WHERE effect = 'remove_member' AND subject = ? ORDER BY created_at DESC LIMIT 1`)
        .get(twice.pk) as { id: string; status: string } | undefined;
    assert(paused.status === 200 && rowOf(twice)?.status === 'disabled' && pauseVote?.status === 'open',
        `an admin pauses it later: paused, its remove_member vote open (${show(paused)}, vote ${pauseVote?.status})`);
    const pausedRead = await call('GET', twice, '/api/community/info');
    assert(pausedRead.body?.code !== 'account_retired', `its key reads as paused, not retired (${show(pausedRead)})`);
    const listedPaused = await adminRow(owner, twice);
    assert(listedPaused?.status === 'disabled' && listedPaused?.retiredAt === null, `the owners' list shows a pause, not a retire (${JSON.stringify(listedPaused)?.slice(0, 160)})`);
    const voteOf = () => db.prepare('SELECT status FROM decisions WHERE id = ?').pluck().get(pauseVote?.id ?? '') as string | undefined;
    const bringBackPaused = await call('POST', null, `/api/local/admin/users/${twice.pk}/unretire`, {}, owner);
    assert(bringBackPaused.status === 409 && bringBackPaused.body?.code === 'not_retired' && rowOf(twice)?.status === 'disabled' && voteOf() === 'open',
        `Bring back refuses it: the pause and its vote stand (${show(bringBackPaused)}, vote ${voteOf()})`);
    const liftPaused = await call('POST', null, `/api/local/admin/users/${twice.pk}/status`, { status: 'active' }, owner);
    assert(liftPaused.status === 200 && rowOf(twice)?.status === 'active' && voteOf() !== 'open',
        `Lift lifts the pause and closes its vote (${show(liftPaused)}, vote ${voteOf()})`);
    // The one way out of 'disabled' that writes the status itself: a retired account deleting itself (allowed, as a
    // closed account's is). Its mark goes with it, with a tombstone.
    const leaver = makeMember('Leaver');
    const retiredLeaver = await call('POST', null, `/api/local/admin/users/${leaver.pk}/retire`, {}, owner);
    const purged = await call('POST', leaver, '/api/member/purge', {});
    assert(retiredLeaver.status === 200 && purged.status === 200 && rowOf(leaver)?.status === 'pruned' && rowOf(leaver)?.retired_at === null
        && !!db.prepare("SELECT 1 FROM tombstones WHERE table_name = 'retired_accounts' AND row_key = ?").get(leaver.pk),
        `a retired account that deletes itself takes its mark with it (${show(purged)} ${JSON.stringify(rowOf(leaver))})`);

    // ── 6. Freeze reads the node ──
    console.log('\n── 6. Freeze: the list carries what the node holds ──');
    const cold = makeMember('Cold');
    assert((await adminRow(owner, cold))?.creditFrozen === false, 'a member nobody froze: creditFrozen false');
    const froze = await call('POST', null, `/api/local/admin/users/${cold.pk}/freeze`, { freeze: true }, owner);
    const frozenRow = await adminRow(owner, cold);
    assert(froze.status === 200 && rowOf(cold)?.credit_frozen === 1 && frozenRow?.creditFrozen === true, `after Freeze the row reads creditFrozen true (${show(froze)})`);
    await call('POST', null, `/api/local/admin/users/${cold.pk}/freeze`, { freeze: false }, owner);
    assert((await adminRow(owner, cold))?.creditFrozen === false && rowOf(cold)?.credit_frozen === 0, 'after Unfreeze it reads false');
    const whole = await call('POST', null, '/api/local/admin/data', {}, owner);
    const wholeRow = (whole.body?.members ?? []).find((m: any) => m.publicKey === cold.pk);
    assert(wholeRow?.creditFrozen === false && 'retiredAt' in (wholeRow ?? {}), "the whole list's row carries the same fields as a page's");

    // ── 7. A standby ──
    console.log('\n── 7. A standby ──');
    const entry = TABLES.retired_accounts as any;
    assert(entry?.plain === true && ['member_pubkey', 'retired_by', 'retired_at'].every(c => entry.columns.includes(c)), 'retired_accounts is a plain table a standby copies, every column');
    assert(!!db.prepare("SELECT 1 FROM tombstones WHERE table_name = 'retired_accounts'").get(), "Bring back's delete left a tombstone, so a standby drops the row too");
    const spare = makeMember('Spare');
    setNodeRole('backup');
    try {
        const onStandby = await call('POST', null, `/api/local/admin/users/${spare.pk}/retire`, {}, owner);
        assert(onStandby.status === 409 && onStandby.body?.code === 'standby' && rowOf(spare)?.status === 'active', `a standby retires nothing (${show(onStandby)})`);
    } finally {
        setNodeRole('primary');
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
