/**
 * Retire an empty duplicate (Marty, 14 Nov 2026: "if I suspend - I don't want to take this to a vote and annoy people voting
 * to suspend an account that was set up in error"). An owner, by their own key session, retires an account that holds
 * nothing and did nothing (emptyAccountRefusal): no vote opens and nothing is deleted. The row goes 'disabled', the one
 * status every reader already treats as acting for nothing (it posts, pays, messages and brings in nobody), and carries
 * a row in retired_accounts (who, when): its key is refused at every signed route as a closed account's is
 * (https-server.ts), it leaves the member directory and the community's member count, and the owners' member list shows
 * it as "Retired (empty duplicate)". Bring back (bringBackRetired) undoes it exactly. The status travels in the members
 * row as every status change does, and retired_accounts is a plain table, so a standby and a backup carry both
 * (engine/replication-manifest.ts). A new table, not new columns: no schema step on any node.
 *
 * An account that is not empty is refused in a plain sentence naming what it holds, and Suspend (the community's vote,
 * where it votes) stays the way for it.
 */
import { word } from '@beanpool/core';
import { db } from '../db/db.js';
import { assertPlainTablesWritable } from '../config/node-role.js';
import { setUserStatusRow, broadcast } from '../state-engine.js';
import { namesMemberSql } from '../decisions-engine.js';
import { isMemberKeySpelling } from './member-key.js';

export const RETIRE_WORDS = {
    ownAccount: word("You can't retire your own account."),
    notPerson: word("Only a person's account in this community can be retired."),
    notActive: word('Only an active account can be retired. This one is already suspended, removed or retired.'),
    holdsRole: word('They hold a role here (owner, admin or moderator). Take the role away first.'),
    balance: word('Their balance is not 0.'),
    posts: word('They have posted, listed, made a group, invited someone into a group or answered an event.'),
    trades: word('They have traded, paid, been paid or been asked to pay.'),
    messages: word('They have sent messages.'),
    credit: word('They have given credit, been given credit, or owe some.'),
    enterprise: word('They keep an enterprise or started a project.'),
    invited: word('They brought someone into the community, answered a request to join, or helped someone back into their account.'),
    votes: word('They have voted, proposed a decision, rated or reported someone, or a decision or report names them.'),
    namesList: word('They are, or were, confirmed on the names list.'),
    actedAsRole: word('They have acted here as an owner, admin or moderator.'),
    notEmpty: word('This is not an empty account, so it cannot be retired. Suspend them instead if they must stop.'),
    keyOnly: word('Sign in with your own key to retire an account, so it is logged in your name.'),
    ownerOnly: word('Only an owner can retire an empty duplicate.'),
    notRetired: word('This account is not retired.'),
    useBringBack: word('This account was retired as an empty duplicate. Use Bring back to undo it.'),
    signedOut: word('This account was retired as an empty duplicate, so the community no longer accepts it. Use your other account, or ask an owner to bring this one back.'),
} as const;

export type EmptyRule = 'own_account' | 'not_person' | 'not_active' | 'holds_role' | 'balance' | 'posts' | 'trades' | 'messages'
    | 'credit' | 'enterprise' | 'invited' | 'votes' | 'names_list' | 'acted_as_role';

/**
 * What makes an account not empty, one rule a kind of activity, each the tables and columns that could hold it. The line:
 * anything the account did counts, its acts as an owner, admin or moderator too (`acted_as_role`, so a former one's
 * account is never "empty"); only what was done to it, its own settings and reading, and throwaway keys do not. Every
 * column of the schema that names a member's key (a foreign key to members, or a TEXT column whose name says it holds
 * one) is here or in the suite's NOT_ACTIVITY with its reason: test-retire-empty-duplicate.ts measures the schema against
 * both, so a new table has to say which. `@pk` is the account's key.
 */
export const EMPTY_RULES: ReadonlyArray<{ rule: EmptyRule; checks: ReadonlyArray<{ table: string; columns: readonly string[]; where?: string }> }> = [
    { rule: 'holds_role', checks: [
        { table: 'node_roles', columns: ['member_pubkey'] },
        { table: 'suspended_node_roles', columns: ['member_pubkey'] },
    ] },
    { rule: 'posts', checks: [
        { table: 'posts', columns: ['author_pubkey', 'created_by', 'accepted_by', 'assigned_to', 'target_pubkey'] },
        { table: 'event_rsvps', columns: ['member_pubkey', 'let_in_by'] },
        { table: 'groups', columns: ['created_by', 'lead_pubkey', 'circle_starter'] },
        // Whom it invited into a group as a convenor, or let in from a request (engine groups.ts inviteGroupMember): sent,
        // accepted or declined, each its own act, wherever the group came from.
        { table: 'group_members', columns: ['invited_by'] },
        { table: 'group_invite_declines', columns: ['invited_by'] },
        { table: 'creator_channels', columns: ['owner_pubkey'] },
        { table: 'pulse_items', columns: ['owner_pubkey'] },
        // A guide page it sent, waiting or answered (engine/knowledge-drafts.ts).
        { table: 'knowledge_drafts', columns: ['member_pubkey'] },
        // A listing it shared outside, and a request to join that came by that link (engine/peek-tickets.ts).
        { table: 'peek_tickets', columns: ['sharer_pubkey'] },
        { table: 'join_requests', columns: ['via_sharer_pubkey'] },
        // An assistant took its posts down (engine/agent-takedowns.ts): it posted.
        { table: 'agent_takedowns', columns: ['member_pubkey'] },
        // The forum (engine/forum.ts): a topic it started, and each opening post or reply it wrote, a removed one too (its row
        // stays as a marker, words blanked). An edit is of its own post (forum_post_edits names no key); reports come with F2.
        { table: 'forum_topics', columns: ['writer_pubkey'] },
        { table: 'forum_posts', columns: ['writer_pubkey'] },
    ] },
    { rule: 'trades', checks: [
        { table: 'transactions', columns: ['from_pubkey', 'to_pubkey'] },
        { table: 'marketplace_transactions', columns: ['buyer_pubkey', 'seller_pubkey'] },
        { table: 'standing_deals', columns: ['payer_pubkey', 'payee_pubkey', 'stopped_by'] },
        { table: 'standing_period_changes', columns: ['asked_by', 'answered_by'] },
        { table: 'money_acts', columns: ['account', 'recipient', 'keeper', 'for_enterprise'] },
        { table: 'bills', columns: ['biller_pubkey', 'payer_pubkey', 'sent_by'] },
        { table: 'settlements', columns: ['buyer_pubkey', 'seller_pubkey'] },
        { table: 'money_requests', columns: ['payer_pubkey'] },
    ] },
    { rule: 'messages', checks: [
        { table: 'messages', columns: ['author_pubkey'] },
        { table: 'withheld_lines', columns: ['author_pubkey'] },
        { table: 'withheld_conversations', columns: ['owner_pubkey'] },
        { table: 'withheld_overlays', columns: ['author_pubkey'] },
        { table: 'dm_requests', columns: ['from_pubkey', 'accepted_by'] },
        { table: 'request_limits', columns: ['sender_pubkey'] },
        // Mail it sent to someone in another community (engine/relay-outbox.ts: a line, a photo or voice, or a delete of one),
        // while the outbox keeps the row: 30 days after its last change, and never on a standby (`local`). A receipt is its
        // device saying mail came to it: reading, not sending. Mail waiting for it (relay_mail.recipient) is done to it.
        { table: 'relay_outbox', columns: ['sender_key'], where: "kind != 'receipt'" },
    ] },
    { rule: 'credit', checks: [
        { table: 'members', columns: ['public_key'], where: 'COALESCE(earned_credit_c, 0) != 0' },
        { table: 'room_gifts', columns: ['from_pubkey', 'to_pubkey', 'root_pubkey'] },
        { table: 'vouchers', columns: ['member_pubkey', 'made_by'] },
        { table: 'voucher_allocations', columns: ['member_pubkey'] },
        { table: 'names_debts', columns: ['repaying_pubkey'] },
        { table: 'names_debt_payments', columns: ['payer_pubkey'] },
        { table: 'known_floor_exceptions', columns: ['member_pubkey'] },
        { table: 'known_floor_log', columns: ['member_pubkey'] },
        // A new member whose credit allowance the cohort check found past its line (engine/audit.ts): given credit.
        { table: 'cohort_allowance_members', columns: ['member_pubkey'] },
    ] },
    { rule: 'enterprise', checks: [
        { table: 'treasury_operators', columns: ['member_pubkey', 'treasury_pubkey'] },
        { table: 'enterprise_pledges', columns: ['keeper', 'enterprise'] },
        { table: 'projects', columns: ['creator_pubkey', 'enterprise_pubkey'] },
        { table: 'deferred_wage_claims', columns: ['keeper_pubkey', 'enterprise_pubkey'] },
        { table: 'shops', columns: ['owner_pubkey'] },
        { table: 'enterprise_keeper_requests', columns: ['member_pubkey', 'enterprise_pubkey', 'decided_by'] },
        { table: 'enterprise_keeper_changes', columns: ['member_pubkey', 'enterprise_pubkey', 'proposed_by', 'resolved_by'] },
        { table: 'keeper_own_posts', columns: ['keeper'] },
        // An enterprise's row it paused or began to wind up.
        { table: 'members', columns: ['paused_by', 'wind_up_initiated_by'] },
        { table: 'enterprise_succession_proposals', columns: ['proposer_pubkey', 'candidate_pubkey', 'lead_pubkey', 'enterprise_pubkey'] },
    ] },
    { rule: 'invited', checks: [
        { table: 'members', columns: ['invited_by'] },
        { table: 'invite_codes', columns: ['created_by'], where: 'used_by IS NOT NULL' },
        { table: 'invite_asks', columns: ['asker_pubkey'] },
        { table: 'join_requests', columns: ['decided_by'] },
        // A piece of someone's 12 words it released as their keeper (engine/recovery-release.ts).
        { table: 'recovery_releases', columns: ['released_by'] },
    ] },
    { rule: 'votes', checks: [
        { table: 'decision_votes', columns: ['voter_pubkey'] },
        { table: 'poll_votes', columns: ['voter_pubkey'] },
        { table: 'enterprise_succession_votes', columns: ['voter_pubkey'] },
        { table: 'decisions', columns: ['author_pubkey', 'subject'] },
        { table: 'ratings', columns: ['rater_pubkey', 'target_pubkey'] },
        { table: 'abuse_reports', columns: ['reporter_pubkey', 'target_pubkey'] },
        // A group's lead-convenor election it proposed, stood in or voted in (engine/group-succession.ts).
        { table: 'group_convenor_proposals', columns: ['proposer_pubkey', 'candidate_pubkey', 'convenor_pubkey'] },
        { table: 'group_convenor_votes', columns: ['voter_pubkey'] },
        { table: 'pricing_reports', columns: ['reporter_pubkey'] },
        // "This helped" on a guide page.
        { table: 'knowledge_helped', columns: ['member_pubkey'] },
    ] },
    { rule: 'names_list', checks: [
        // A names-list confirmation binds a person's entry to this key (engine/names-list.ts), live or revoked.
        { table: 'confirmations', columns: ['member_pubkey'] },
    ] },
    { rule: 'acted_as_role', checks: [
        { table: 'decisions', columns: ['admin_halted_by', 'case_hidden_by', 'reply_hidden_by', 'owner_decided_by'] },
        { table: 'marketplace_transactions', columns: ['dispute_resolved_by'] },
        { table: 'invite_codes', columns: ['issued_by'] },
        { table: 'node_roles', columns: ['granted_by', 'break_glass_made_by'] },
        { table: 'suspended_node_roles', columns: ['granted_by'] },
        { table: 'treasury_operators', columns: ['granted_by'] },
        { table: 'retired_accounts', columns: ['retired_by'] },
        { table: 'member_badges', columns: ['set_by'] },
        { table: 'free_tag_rules', columns: ['set_by'] },
        { table: 'known_floor_exceptions', columns: ['set_by'] },
        { table: 'known_floor_log', columns: ['actor_pubkey'] },
        { table: 'credit_look_log', columns: ['actor_pubkey'] },
        { table: 'vouchers', columns: ['stopped_by'] },
        { table: 'voucher_allocations', columns: ['actor'] },
        { table: 'names_debts', columns: ['settled_by'] },
        { table: 'names_entries', columns: ['created_by', 'updated_by'] },
        { table: 'names_shares', columns: ['from_pubkey', 'to_pubkey'] },
        { table: 'names_copies', columns: ['owner_pubkey'] },
        { table: 'names_dropped_holders', columns: ['holder_pubkey'] },
        { table: 'names_access_log', columns: ['actor_pubkey'] },
        { table: 'confirmations', columns: ['confirmed_by', 'seconded_by', 'revoked_by'] },
        { table: 'health_access_log', columns: ['actor_pubkey'] },
        { table: 'community_settings_log', columns: ['actor_pubkey'] },
        { table: 'knowledge_drafts', columns: ['answered_by'] },
        { table: 'rekey_requests', columns: ['operator_pubkey'] },
        { table: 'rekey_audit_log', columns: ['operator_pubkey'] },
        { table: 'bring_back_log', columns: ['operator_pubkey'] },
    ] },
];

/** The words of each rule's refusal: what the account holds, then that it can't be retired. */
const RULE_WORDS: Record<EmptyRule, string> = {
    own_account: RETIRE_WORDS.ownAccount,
    not_person: RETIRE_WORDS.notPerson,
    not_active: RETIRE_WORDS.notActive,
    holds_role: RETIRE_WORDS.holdsRole,
    balance: RETIRE_WORDS.balance,
    posts: RETIRE_WORDS.posts,
    trades: RETIRE_WORDS.trades,
    messages: RETIRE_WORDS.messages,
    credit: RETIRE_WORDS.credit,
    enterprise: RETIRE_WORDS.enterprise,
    invited: RETIRE_WORDS.invited,
    votes: RETIRE_WORDS.votes,
    names_list: RETIRE_WORDS.namesList,
    acted_as_role: RETIRE_WORDS.actedAsRole,
};

export interface EmptyRefusal { rule: EmptyRule; status: number; code: string; error: string }

function refusal(rule: EmptyRule): EmptyRefusal {
    // The account itself (yourself, no person, not active, a role) is its own sentence; what it did or holds is followed
    // by the way that stays for it, Suspend.
    const own = rule === 'own_account' || rule === 'not_person' || rule === 'not_active' || rule === 'holds_role';
    return {
        rule,
        status: rule === 'own_account' ? 403 : rule === 'not_person' ? 404 : 409,
        code: rule === 'own_account' ? 'own_account' : `not_empty_${rule}`,
        error: own ? RULE_WORDS[rule] : `${RULE_WORDS[rule]} ${RETIRE_WORDS.notEmpty}`,
    };
}

/** Whether a table and its columns are in this database (an engine test's own schema may lack one). */
function hasTable(table: string): boolean {
    return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
}

/**
 * Why this account is not an empty duplicate `actor` may retire, or null when it is (the rules in the order the brief
 * gives them): not yourself; a person's account here (a key in a person's spelling, so never the node's own SYSTEM row,
 * and a member's row, no visitor's, no enterprise's); active (not already suspended, removed or retired); holding no
 * role; balance 0; and nothing in any of EMPTY_RULES' tables: no post or listing, no group invitation sent,
 * no trade, payment or deal open or done, no message sent, no credit given, received or owed, no enterprise kept, nobody
 * brought in, no vote, decision, rating or report by or about them, no names-list confirmation, and nothing done as an
 * owner, admin or moderator. A decision that names them (as its subject, or in a branch) counts too.
 */
export function emptyAccountRefusal(actor: string, target: string): EmptyRefusal | null {
    if (actor === target) return refusal('own_account');
    // A person's key is 64 lower-case hexadecimal characters (engine/member-key.ts). The node's own SYSTEM row (state-engine
    // initStateEngine) is a member row with no visitor or enterprise flag, active and, on a fresh node, holding nothing; a
    // row a door stored under another spelling of a key acts for nobody. Neither is a person's account.
    if (!isMemberKeySpelling(target)) return refusal('not_person');
    const row = db.prepare('SELECT status, is_visitor, is_treasury FROM members WHERE public_key = ?').get(target) as
        { status: string | null; is_visitor: number | null; is_treasury: number | null } | undefined;
    if (!row || row.is_visitor || row.is_treasury) return refusal('not_person');
    if ((row.status ?? 'active') !== 'active') return refusal('not_active');
    const balance = db.prepare('SELECT balance_c FROM accounts WHERE public_key = ?').pluck().get(target) as number | undefined;
    for (const { rule, checks } of EMPTY_RULES) {
        // The balance right after the role (the brief's order): a row in `accounts`, never a ledger row, so not a table check.
        if (rule !== 'holds_role' && balance !== undefined && balance !== 0) return refusal('balance');
        for (const check of checks) {
            if (!hasTable(check.table)) continue;
            const named = check.columns.map(c => `${c} = @pk`).join(' OR ');
            const sql = `SELECT 1 FROM ${check.table} WHERE (${named})${check.where ? ` AND ${check.where}` : ''} LIMIT 1`;
            if (db.prepare(sql).get({ pk: target })) return refusal(rule);
        }
        if (rule === 'votes' && db.prepare(`SELECT 1 FROM decisions d WHERE ${namesMemberSql('d', '@pk')} LIMIT 1`).get({ pk: target })) {
            return refusal('votes');
        }
    }
    return null;
}

/** Whether this key's account is a retired empty duplicate. */
export function isRetiredKey(pubkey: string): boolean {
    if (!pubkey) return false;
    return !!db.prepare(`SELECT 1 FROM retired_accounts r JOIN members m ON m.public_key = r.member_pubkey
        WHERE r.member_pubkey = ? AND m.status = 'disabled'`).get(pubkey);
}

/**
 * Retire `target`, an empty duplicate, by the owner `actor` (the route has already checked the owner's own key session).
 * Refused (the EmptyRefusal) unless it is empty now; read and written in one transaction, so nothing it did in between
 * slips through. Returns null once done; every app is told the member changed (profile_updated) after it commits.
 */
export function retireEmptyDuplicate(actor: string, target: string): EmptyRefusal | null {
    assertPlainTablesWritable();
    const refused = db.transaction(() => {
        const why = emptyAccountRefusal(actor, target);
        if (why) return why;
        setUserStatusRow(target, 'disabled', { actor, how: 'retired as an empty duplicate' });
        // No row is left from before: every way out of 'disabled' clears it (setUserStatusRow). The upsert only keeps a
        // retire from failing on a stray one.
        db.prepare(`INSERT INTO retired_accounts (member_pubkey, retired_by) VALUES (?, ?)
            ON CONFLICT(member_pubkey) DO UPDATE SET retired_by = excluded.retired_by, retired_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
            .run(target, actor);
        return null;
    })();
    if (!refused) broadcast({ type: 'profile_updated', publicKey: target });
    return refused;
}

/** Bring back a retired empty duplicate: active again, the mark cleared. False when the account is not a retired one. */
export function bringBackRetired(target: string): boolean {
    assertPlainTablesWritable();
    const done = db.transaction(() => {
        if (!isRetiredKey(target)) return false;
        // Active again, and setUserStatusRow clears the mark (with a tombstone, so a standby drops it too).
        setUserStatusRow(target, 'active');
        return true;
    })();
    if (done) broadcast({ type: 'profile_updated', publicKey: target });
    return done;
}
