/**
 * Retire an empty duplicate (Marty, 14 Nov 2026: "if I suspend - I don't want to take this to a vote and annoy people voting
 * to suspend an account that was set up in error"; engine/retire-duplicate.ts), and the manager's Freeze reading the node's
 * own state ("sort the freeze to frozen button"). Over HTTPS through the real middleware.
 *
 *   1. The schema, measured: every column that references a member's key (each foreign key to members) is either in one of
 *      EMPTY_RULES' checks or named below as no activity of the account's, with why. A new table must say which.
 *   2. "Empty", a rule at a time: a fresh account may be retired; then one account per rule, each holding only that one
 *      thing, is refused with that rule's code and words (yourself, an enterprise, a suspended account, a role, a balance,
 *      a post, a payment, a message sent, credit, an enterprise kept, someone brought in, a report). Each refusal for what
 *      the account did or holds also says Suspend stays the way.
 *   3. Who: an owner's own key session only. An admin is refused, an owner's automation token is refused; a refused
 *      retire writes nothing.
 *   4. The retire: 200, no vote or decision opened, nothing deleted (the row and its account stay); 'disabled' with
 *      retired_at and retired_by (the owner); the key's signed requests are refused (account_retired); the member
 *      directory and the community's member count leave it out; the owners' list keeps it, marked retiredAt; Lift
 *      suspension is refused (use Bring back); retiring it again is refused (not active).
 *   5. Bring back: active again, the mark cleared, its key signs again, and it is back in the directory and the count.
 *   6. Freeze: the owners' member rows carry creditFrozen as the node holds it, after a freeze and after an unfreeze.
 *   7. A standby: the members row's copy carries retired_at and retired_by (the manifest), and a standby retires nothing
 *      (409 standby).
 *
 * Run: SERVER_SUITES_ONLY=test-retire-empty-duplicate TEST_ALL_JOBS=2 node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember } from './state-engine.js';
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
 * Every column with a foreign key to members that is no activity of the account itself, and why. Anything else must be in
 * EMPTY_RULES. (A column without a foreign key that names a member's key, such as transactions.from_pubkey, is in
 * EMPTY_RULES by hand: the rule's checks list each.)
 */
const NOT_ACTIVITY: Record<string, string> = {
    'members.invited_by': 'who invited this account: in EMPTY_RULES as `invited` the other way (who it invited)',
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
    'decisions.admin_halted_by': 'an admin halting a decision: only a role holder (`holds_role`)',
    'group_members.member_pubkey': 'a group someone added it to: a group it made is `posts`',
    'group_members.invited_by': 'whom it invited into a group: needs a group it is in; making one is `posts`',
    'federation_links.treasury_pubkey': "a link's treasury: an enterprise row, never a person's (`not_person`)",
    'federation_link_treasuries.treasury_pubkey': "a link's treasury: an enterprise row, never a person's (`not_person`)",
    'group_invite_declines.invitee_pubkey': 'a group invitation someone else sent it, declined: not its act on anyone',
    'chat_mutes.member_pubkey': 'chats it muted: its own setting',
    'thread_read_cursors.member_pubkey': 'how far it read a thread: its own reading',
    'member_tool_state.public_key': "its own tools' settings",
};

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

const rowOf = (who: Id) => db.prepare('SELECT status, retired_at, retired_by, credit_frozen FROM members WHERE public_key = ?').get(who.pk) as
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
    grantNodeRole(ada.pk, 'admin', 'SYSTEM');
    const adaAdmin = sessionHeaders(ada.pk, 'admin');
    const reader = makeMember('Reader');

    // ── 1. The schema, measured ──
    console.log('── 1. Every column naming a member is a rule or named as no activity ──');
    const ruled = new Set(EMPTY_RULES.flatMap(r => r.checks.flatMap(c => c.columns.map(col => `${c.table}.${col}`))));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").pluck().all() as string[];
    const unclassified: string[] = [];
    for (const t of tables) {
        for (const fk of db.prepare(`SELECT "table" AS ref, "from" AS col FROM pragma_foreign_key_list(?)`).all(t) as Array<{ ref: string; col: string }>) {
            if (fk.ref !== 'members') continue;
            const name = `${t}.${fk.col}`;
            if (!ruled.has(name) && !(name in NOT_ACTIVITY)) unclassified.push(name);
        }
    }
    assert(unclassified.length === 0, `every foreign key to members is a rule or named as no activity (unclassified: ${unclassified.join(', ') || 'none'})`);
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

    const cases: Array<{ rule: string; make: () => Id; target?: (id: Id) => string }> = [
        { rule: 'own_account', make: () => founder },
        { rule: 'not_person', make: () => makeMember('Shop', { treasury: true }) },
        { rule: 'not_active', make: () => { const m = makeMember('Paused'); db.prepare("UPDATE members SET status = 'disabled' WHERE public_key = ?").run(m.pk); return m; } },
        { rule: 'holds_role', make: () => { const m = makeMember('Mod'); grantNodeRole(m.pk, 'moderator', 'SYSTEM'); return m; } },
        { rule: 'balance', make: () => { const m = makeMember('Rich'); db.prepare('UPDATE accounts SET balance_c = 500 WHERE public_key = ?').run(m.pk); return m; } },
        { rule: 'posts', make: () => {
            const m = makeMember('Poster');
            db.prepare(`INSERT INTO posts (id, type, category, title, description, author_pubkey) VALUES (?, 'offer', 'other', 'A thing', 'A thing', ?)`).run(`p-${m.pk.slice(0, 8)}`, m.pk);
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
            `${c.rule}: refused in words, nothing written (${show(tried)})`);
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
    const copied = TABLES.members.kind === 'replicated-except' || TABLES.members.kind === 'replicated' ? (TABLES.members as any).columns as string[] : [];
    assert(copied.includes('retired_at') && copied.includes('retired_by'), "the members row's copy carries retired_at and retired_by");
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
