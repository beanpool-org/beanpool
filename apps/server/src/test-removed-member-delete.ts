/**
 * Delete account from an account the community closed, and from a visitor's row (Marty's card removed-member-delete,
 * 2026-09-27: "Erase their profile"; the same rule for a visitor's own row, the director's call).
 *
 * A member removed by an admin or a vote keeps their profile here so a vote can bring them back. Until this change their
 * Delete account was answered "already deleted": the phone wiped itself and said the profile was purged, and nothing here
 * was erased. A visitor's was answered "Member not found". Every Delete account below goes over HTTP through the real
 * signature middleware.
 *
 *  1. A member removed by an admin keeps their name, photo, bio, contact details, friends (both ways) and sign-in recovery
 *     copies. They sign Delete account: all of it is erased, and the friends and recovery copies are tombstoned so a
 *     standby deletes them too. Their Beans went to the Commons at the removal; nothing moves now and the ledger audit
 *     is unchanged. The key is still refused everything else, the open door still refuses it and their sign-in account
 *     is not released. Asking again is answered as before ("already") and changes nothing, activity included. A removed
 *     member with a deal still under way, which their key can't close, is told who can, and nothing changes until then.
 *  2. The community can no longer bring that account back: a reinstate proposal over HTTP is refused in plain words; a
 *     reinstate vote already open when they deleted it closes without doing anything; an admin halting a removal whose
 *     grace period they deleted the account in, and a report's suspension, both leave the account closed.
 *  3. A visitor's own row (a member's DM made it, Beans reached it): its generated name goes, its Beans go to the Commons
 *     as a member's self-delete sends theirs (ledger audit unchanged), its key is refused everything after, the open door
 *     refuses it, and it can't be reinstated. The member keeps their DM with it.
 *  4. A member's own Delete account is unchanged: it still frees the sign-in account they joined with through the open
 *     door. It can't be reinstated either.
 *  5. Nobody deletes another key's row: a body naming the other key, another key's header on a signature, no signature,
 *     a key with no row, a replayed request. Each leaves the other key's row as it was.
 *  6. A keeper's Delete account leaves each enterprise they keep the way a keeper leaves one (step down, an admin's unbind,
 *     4113694084), never with a bare delete of their bindings. A removed lead's place goes to the longest-serving active
 *     keeper, marked auto-promoted, so succession works again; a removed sole keeper's enterprise pauses. The same for an
 *     active lead's own Delete account, which left the enterprise with no lead before this too. A plain keeper is unbound
 *     and their pledge released, the lead untouched. Every pending keeper change naming them closes. No enterprise's
 *     Beans move, and the ledger audit is unchanged.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-removed-member-delete.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.NODE_ENV = 'test';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;
const PW = 'RemovedDeletePass123!';
process.env.ADMIN_PASSWORD = PW;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import {
    initStateEngine, transfer, adminPruneUser, createConversation, sendMessage, getBalance, getCommonsBalance, runLedgerAudit, createPost,
    createTreasury, adminAssignTreasuryOperator, proposeKeeperRemoval, requestToJoinEnterprise, approveKeeperRequest, getLeadInactivity,
} from './state-engine.js';
import { createDecision, executeDecision, getDecision } from './decisions-engine.js';
import { openJoinTaken } from './engine/open-join.js';
import { startHttpsServer } from './https-server.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { initAdminPassword } from './config/local-config.js';
import { db } from './db/db.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const OWNER_DELETED = 'This account was deleted by its owner; they can rejoin with a new invite';
const CLOSED = 'This key’s account in this community was closed, so the community no longer accepts it.';
const DEAL_UNDER_WAY = 'This account can’t be erased while a deal or a payment between communities is still under way. Once the other member or an admin closes it, it can be.';

type Id = { pk: string; privateKey: crypto.KeyObject; name: string };
type Res = { status: number; body: any };

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey, name };
}

/** A member with a whole profile, Beans, a friend each way and two sign-in recovery copies. */
function makeMember(name: string, beans = 40): Id {
    const id = keypair(name);
    db.prepare(
        `INSERT INTO members (public_key, callsign, joined_at, avatar_url, bio, contact_value, contact_visibility, archetype, status, updated_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?, ?, 'community', 'gardener', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).run(id.pk, name, AVATAR, `${name} grows garlic`, `${name.toLowerCase()}@example.com`);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    if (beans > 0) transfer('genesis', id.pk, beans, `seed ${name}`, 'direct', true);
    return id;
}

function giveFriendsAndCopies(m: Id, friend: Id): void {
    db.prepare('INSERT INTO friends (owner_pubkey, friend_pubkey) VALUES (?, ?)').run(m.pk, friend.pk);
    db.prepare('INSERT INTO friends (owner_pubkey, friend_pubkey) VALUES (?, ?)').run(friend.pk, m.pk);
    for (const [i, provider] of [[1, 'google'], [2, 'apple']] as const) {
        db.prepare(`INSERT INTO recovery_shares (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share, share_iv, share_tag, sso_lookup_hash, sso_lookup_salt)
                    VALUES (?, 'sso', ?, ?, 'c2hhcmU=', 'aXY=', 'dGFn', ?, 'c2FsdA==')`).run(m.pk, provider, i, `hash-${m.name}-${provider}`);
    }
}

/** The app's signed request (the format before request binding, which every node still takes), ready to send or send again. */
function signed(method: 'GET' | 'POST', path: string, id: Id, body?: unknown, headerKey = id.pk) {
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`;
    const headers: Record<string, string> = {
        'X-Public-Key': headerKey,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return { method, path, headers, body: body !== undefined ? bodyString : undefined };
}
async function send(req: ReturnType<typeof signed>): Promise<Res> {
    resetGatewayRateLimit();
    const res = await fetch(`${BASE}${req.path}`, { method: req.method, headers: req.headers, body: req.body });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}
const call = (method: 'GET' | 'POST', path: string, id: Id, body?: unknown) => send(signed(method, path, id, body));
async function asAdmin(method: 'POST', path: string, body: unknown): Promise<Res> {
    resetGatewayRateLimit();
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-admin-password': PW }, body: JSON.stringify(body) });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}
async function unsigned(path: string, body: unknown): Promise<Res> {
    resetGatewayRateLimit();
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 160)}`;
const isClosed = (r: Res) => r.status === 403 && r.body?.code === 'account_closed' && r.body?.error === CLOSED;

/** What Delete account erases, as the row holds it. */
const profileOf = (pk: string) => db.prepare(
    'SELECT callsign, avatar_url, bio, contact_value, contact_visibility, archetype, status FROM members WHERE public_key = ?').get(pk) as Record<string, unknown> | undefined;
const erased = (pk: string): boolean => {
    const p = profileOf(pk);
    return !!p && p.status === 'pruned' && p.callsign === 'Deleted Member' && p.avatar_url === null && p.bio === null
        && p.contact_value === null && p.contact_visibility === null && p.archetype === null;
};
const friendsOf = (pk: string) => (db.prepare('SELECT COUNT(*) AS n FROM friends WHERE owner_pubkey = ? OR friend_pubkey = ?').get(pk, pk) as { n: number }).n;
const copiesOf = (pk: string) => (db.prepare('SELECT COUNT(*) AS n FROM recovery_shares WHERE owner_pubkey = ?').get(pk) as { n: number }).n;
const tombstoned = (table: string, key: string) => !!db.prepare('SELECT 1 FROM tombstones WHERE table_name = ? AND row_key = ?').get(table, key);
const statusOf = (pk: string) => (db.prepare('SELECT status FROM members WHERE public_key = ?').get(pk) as { status: string } | undefined)?.status;
const txCountFor = (pk: string) => (db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE from_pubkey = ? OR to_pubkey = ?').get(pk, pk) as { n: number }).n;
const joinHashOf = (pk: string) => (db.prepare('SELECT join_hash FROM open_joins WHERE member_pubkey = ?').get(pk) as { join_hash: string } | undefined)?.join_hash;
const joinedThroughTheDoor = (m: Id, hash: string) =>
    db.prepare("INSERT INTO open_joins (member_pubkey, provider, join_hash, ip_hash) VALUES (?, 'google', ?, 'ip-hash')").run(m.pk, hash);

/** The whole database, table by table, so a step can say which table changed, if any did. */
function snapshot(): Map<string, string> {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    const out = new Map<string, string>();
    for (const { name } of tables) {
        const h = crypto.createHash('sha256');
        for (const row of db.prepare(`SELECT * FROM "${name}"`).iterate()) h.update(JSON.stringify(row));
        out.set(name, h.digest('hex'));
    }
    return out;
}
const changedTables = (a: Map<string, string>, b: Map<string, string>) =>
    [...new Set([...a.keys(), ...b.keys()])].filter(t => a.get(t) !== b.get(t));
/** A member row as it is, activity stamp and all. */
const wholeRow = (pk: string) => JSON.stringify(db.prepare('SELECT * FROM members WHERE public_key = ?').get(pk));

/** Every Bean on the node: the ledger audit's figures, which Delete account must leave as they are. */
const audit = () => { const a = runLedgerAudit(); return { ok: a.ok, drift: Math.round(a.drift * 1e6) / 1e6 }; };

/** An enterprise holding 20 Beans of its own: its lead, then its other keepers, bound in order of seniority. */
let enterprises = 0;
function makeEnterprise(lead: Id, others: Id[]): string {
    const { publicKey: ent } = createTreasury(`EnterpriseRD${++enterprises}`, 'avatar', 0);
    [lead, ...others].forEach((k, i) => {
        adminAssignTreasuryOperator(ent, k.pk, 'admin', 0);
        db.prepare('UPDATE treasury_operators SET granted_at = ? WHERE treasury_pubkey = ? AND member_pubkey = ?')
            .run(new Date(Date.now() - (100 - i) * 86400000).toISOString(), ent, k.pk);
    });
    db.prepare("UPDATE treasury_operators SET role = 'lead' WHERE treasury_pubkey = ? AND member_pubkey = ?").run(ent, lead.pk);
    transfer('genesis', ent, 20, 'seed enterprise', 'direct', true);
    return ent;
}
const roleIn = (ent: string, pk: string) =>
    (db.prepare('SELECT role FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?').get(ent, pk) as { role: string } | undefined)?.role ?? null;
const keepersOf = (ent: string) => db.prepare('SELECT member_pubkey AS pk, role, auto_promoted_at FROM treasury_operators WHERE treasury_pubkey = ? ORDER BY granted_at')
    .all(ent) as { pk: string; role: string; auto_promoted_at: string | null }[];
const pausedOf = (ent: string) => db.prepare('SELECT paused, paused_by FROM members WHERE public_key = ?').get(ent) as { paused: number; paused_by: string | null };
const changeOf = (id: string) => db.prepare('SELECT status, reason FROM enterprise_keeper_changes WHERE id = ?').get(id) as { status: string; reason: string | null };
const requestStatus = (id: string) => (db.prepare('SELECT status FROM enterprise_keeper_requests WHERE id = ?').get(id) as { status: string }).status;
const pledgeOf = (ent: string, pk: string) => (db.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS t FROM enterprise_pledges WHERE enterprise = ? AND keeper = ? AND released_at IS NULL').get(ent, pk) as { t: number }).t;
const beansOf = (...ents: string[]) => ents.map(e => getBalance(e).balance);

async function main(): Promise<void> {
    console.log('Delete account from an account the community closed, and from a visitor’s row\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const alice = makeMember('AliceRD', 200);
    const bob = makeMember('BobRD');
    /** A member with earned standing, as one who has traded has, so they may propose a Decision (one open at a time each). */
    let proposers = 0;
    const proposer = (): Id => {
        const m = makeMember(`ProposerRD${++proposers}`, 0);
        db.prepare('UPDATE members SET earned_credit = 50 WHERE public_key = ?').run(m.pk);
        return m;
    };
    const proposeReinstate = (subject: string) => call('POST', '/api/commons/decisions', proposer(),
        { title: 'Reinstate them', description: 'They have made amends with the community', touches: 'member', effect: 'reinstate_member', subject });

    // ── 1. A member removed by an admin deletes their account ─────────────────────────────────────
    console.log('── 1. A member removed by an admin deletes their account: their profile is erased');
    const rita = makeMember('RitaRD', 40);
    giveFriendsAndCopies(rita, alice);
    joinedThroughTheDoor(rita, 'door-hash-rita');
    adminPruneUser(rita.pk, 'owner:password');
    {
        const kept = profileOf(rita.pk);
        assert(kept?.status === 'pruned' && kept?.callsign === 'RitaRD' && kept?.bio === 'RitaRD grows garlic' && kept?.contact_value === 'ritard@example.com'
            && friendsOf(rita.pk) === 2 && copiesOf(rita.pk) === 2 && getBalance(rita.pk).balance === 0,
            `setup: the removal kept Rita's name, bio, contact, 2 friends and 2 recovery copies, and took her 40 Beans (${JSON.stringify(kept)})`);
    }
    const auditBefore = audit();
    const commonsBefore = getCommonsBalance();
    const ritaTx = txCountFor(rita.pk);
    const generation = (db.prepare('SELECT generation FROM recovery_shares WHERE owner_pubkey = ? LIMIT 1').get(rita.pk) as { generation: number }).generation;

    const del = await call('POST', '/api/member/purge', rita, { action: 'purge_account' });
    assert(del.status === 200 && del.body?.ok === true && del.body?.message !== 'Account is already pruned',
        `Rita signs Delete account and the community erases her account, not "already deleted" (${show(del)})`);
    assert(erased(rita.pk), `her name, photo, bio, contact details and archetype are gone (${JSON.stringify(profileOf(rita.pk))})`);
    assert(friendsOf(rita.pk) === 0 && tombstoned('friends', `${rita.pk}|${alice.pk}`) && tombstoned('friends', `${alice.pk}|${rita.pk}`),
        `her friends are gone both ways, and tombstoned for a standby (${friendsOf(rita.pk)} left)`);
    assert(copiesOf(rita.pk) === 0 && tombstoned('recovery_shares', `${rita.pk}|${generation}`),
        `her sign-in recovery copies are gone, and tombstoned for a standby (${copiesOf(rita.pk)} left)`);
    const auditAfter = audit();
    assert(auditAfter.ok && auditAfter.drift === auditBefore.drift && Math.abs(getCommonsBalance() - commonsBefore) < 1e-9
        && getBalance(rita.pk).balance === 0 && txCountFor(rita.pk) === ritaTx,
        `no Beans move: her balance stays 0, the Commons and the ledger audit are unchanged, no transaction is written (audit ${JSON.stringify(auditBefore)} → ${JSON.stringify(auditAfter)})`);
    {
        const profile = await call('POST', '/api/profile/update', rita, { bio: 'Back again' });
        const read = await call('GET', '/api/community/me', rita);
        const join = await call('POST', '/api/join', rita, { callsign: 'Rita again', provider: 'google', idToken: 'x' });
        assert(isClosed(profile) && isClosed(read) && isClosed(join),
            `her key is still refused everything else, the open door included (profile ${show(profile)}; read ${show(read)}; door ${show(join)})`);
        assert(joinHashOf(rita.pk) === 'door-hash-rita' && openJoinTaken('door-hash-rita') === 'removed',
            `the sign-in account she joined with is not released: the open door still answers it "removed" (${joinHashOf(rita.pk)})`);
        const before = snapshot();
        const row = wholeRow(rita.pk);
        const again = await call('POST', '/api/member/purge', rita, { action: 'purge_account' });
        const changed = changedTables(before, snapshot());
        assert(again.status === 200 && again.body?.ok === true && again.body?.message === 'Account is already pruned' && changed.length === 0 && wholeRow(rita.pk) === row,
            `asking again is answered "already" and changes nothing, activity included (${show(again)}${changed.length ? `; changed: ${changed.join(', ')}` : ''})`);
    }

    // Rex is removed while Alice is buying from him: his key can't close that deal, so the answer says who can.
    {
        const rex = makeMember('RexRD', 0);
        const offer = createPost('offer', 'produce', 'Rex walnuts', 'A bag of walnuts', 5, 'fixed', rex.pk)!;
        db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at, updated_at)
                    VALUES ('rex-deal', ?, ?, ?, 5, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(offer.id, alice.pk, rex.pk);
        adminPruneUser(rex.pk, 'owner:password');
        const before = snapshot();
        const refused = await call('POST', '/api/member/purge', rex, {});
        const changed = changedTables(before, snapshot());
        assert(refused.status === 400 && refused.body?.error === DEAL_UNDER_WAY && changed.length === 0 && profileOf(rex.pk)?.callsign === 'RexRD',
            `a removed member with a deal still under way is told who can close it, and nothing changes (${show(refused)}${changed.length ? `; changed: ${changed.join(', ')}` : ''})`);
        db.prepare("UPDATE marketplace_transactions SET status = 'cancelled' WHERE id = 'rex-deal'").run();
        const later = await call('POST', '/api/member/purge', rex, {});
        assert(later.status === 200 && erased(rex.pk), `once it is closed, his Delete account erases his profile (${show(later)})`);
    }

    // ── 2. Nothing brings that account back ────────────────────────────────────────────────────────
    console.log('\n── 2. The community can no longer reinstate an account its owner deleted');
    {
        const proposal = await proposeReinstate(rita.pk);
        assert(proposal.status === 400 && proposal.body?.error === OWNER_DELETED && statusOf(rita.pk) === 'pruned',
            `a reinstate proposal is refused in plain words (${show(proposal)})`);

        // A vote to reinstate Rob opens while he is removed; he deletes his account before it closes.
        const rob = makeMember('RobRD', 0);
        adminPruneUser(rob.pk, 'owner:password');
        const open = createDecision({ authorPubkey: proposer().pk, title: 'Reinstate Rob', description: 'Rob has made amends with us', touches: 'member',
            effect: 'reinstate_member', subject: rob.pk });
        const robDeletes = await call('POST', '/api/member/purge', rob, {});
        assert(robDeletes.status === 200 && erased(rob.pk), `Rob deletes his account while a vote to reinstate him is open (${show(robDeletes)})`);
        const ran = executeDecision(open.id);
        const after = getDecision(open.id);
        assert(!ran.success && after?.status === 'execution_void' && after?.executionReason === OWNER_DELETED && statusOf(rob.pk) === 'pruned' && erased(rob.pk),
            `the vote closes without doing anything, in plain words, and Rob's account stays closed (${after?.status}: ${after?.executionReason}; ${statusOf(rob.pk)})`);
        const robAgain = await call('POST', '/api/profile/update', rob, { bio: 'Back' });
        assert(isClosed(robAgain), `and his key is still refused (${show(robAgain)})`);

        // A removal passes for Rae: suspended for its 7 days of grace. She deletes her account in them; an admin then halts it.
        const rae = makeMember('RaeRD', 0);
        const removal = createDecision({ authorPubkey: proposer().pk, title: 'Remove Rae', description: 'Rae has harmed members here', touches: 'member',
            effect: 'remove_member', subject: rae.pk });
        const graced = executeDecision(removal.id);
        assert(graced.status === 'execution_pending_grace' && statusOf(rae.pk) === 'disabled', `setup: the removal of Rae is in its grace period (${graced.status}, ${statusOf(rae.pk)})`);
        const raeDeletes = await call('POST', '/api/member/purge', rae, {});
        assert(raeDeletes.status === 200 && erased(rae.pk), `Rae deletes her account in the grace period (${show(raeDeletes)})`);
        const halt = await asAdmin('POST', `/api/local/admin/decisions/${removal.id}/halt`, { reason: 'Rae apologised to everyone' });
        const raeAfter = await call('POST', '/api/profile/update', rae, { bio: 'Back' });
        assert(halt.status === 200 && getDecision(removal.id)?.status === 'admin_halted' && statusOf(rae.pk) === 'pruned' && erased(rae.pk) && isClosed(raeAfter),
            `an admin halting the removal leaves her account closed, and her key refused (halt ${show(halt)}; ${statusOf(rae.pk)}; ${show(raeAfter)})`);

        // A report against Rita from before she was removed: an admin actions it and asks to suspend her.
        db.prepare("INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, reason, status) VALUES ('report-rita', ?, ?, 'spam', 'pending')").run(bob.pk, rita.pk);
        const action = await asAdmin('POST', '/api/local/admin/reports/report-rita/action', { suspendUser: true });
        const ritaAfter = await call('POST', '/api/profile/update', rita, { bio: 'Back' });
        assert(action.status === 200 && statusOf(rita.pk) === 'pruned' && erased(rita.pk) && isClosed(ritaAfter),
            `a report's suspension leaves her account closed, and her key refused (${show(action)}; ${statusOf(rita.pk)}; ${show(ritaAfter)})`);
    }

    // ── 3. A visitor's own row ─────────────────────────────────────────────────────────────────────
    console.log("\n── 3. A visitor deletes its own row: its name goes, its Beans go to the Commons");
    {
        const vic = keypair('VicRD');
        const dm = createConversation('dm', [alice.pk, vic.pk], alice.pk)!;
        sendMessage(dm.id, alice.pk, 'aGkgVmlj', 'bjE=');
        transfer('genesis', vic.pk, 30, 'welcome gift', 'direct', true);
        const row = profileOf(vic.pk);
        assert(!!row && String(row.callsign).startsWith('Visitor-') && getBalance(vic.pk).balance === 30,
            `setup: Vic's row is a visitor's, with a generated name and 30 Beans (${JSON.stringify(row)})`);
        const auditBeforeV = audit();
        const commonsBeforeV = getCommonsBalance();
        const vicDeletes = await call('POST', '/api/member/purge', vic, {});
        assert(vicDeletes.status === 200 && vicDeletes.body?.ok === true && erased(vic.pk),
            `Vic signs Delete account and its row is erased (${show(vicDeletes)}; ${JSON.stringify(profileOf(vic.pk))})`);
        const auditAfterV = audit();
        assert(getBalance(vic.pk).balance === 0 && Math.abs(getCommonsBalance() - (commonsBeforeV + 30)) < 1e-6
            && auditAfterV.ok && auditAfterV.drift === auditBeforeV.drift,
            `its 30 Beans go to the Commons, as a member's self-delete sends theirs, and the ledger audit is unchanged (Commons ${commonsBeforeV} → ${getCommonsBalance()})`);
        const reply = await call('POST', '/api/messages/send', vic, { conversationId: dm.id, authorPubkey: vic.pk, ciphertext: 'aGk=', nonce: 'bjI=' });
        const join = await call('POST', '/api/join', vic, { callsign: 'Vic joins', provider: 'google', idToken: 'x' });
        assert(isClosed(reply) && isClosed(join), `its key is refused everything after, the open door included (reply ${show(reply)}; door ${show(join)})`);
        const proposal = await proposeReinstate(vic.pk);
        assert(proposal.status === 400 && proposal.body?.error === OWNER_DELETED, `and it can't be reinstated (${show(proposal)})`);
        const aliceStill = await call('GET', `/api/messages/${dm.id}`, alice);
        assert(aliceStill.status === 200 && !!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(dm.id),
            `Alice keeps her DM with it (${aliceStill.status})`);
    }

    // ── 4. A member's own Delete account, unchanged ────────────────────────────────────────────────
    console.log("\n── 4. A member's own Delete account is unchanged, and can't be reinstated either");
    {
        const nia = makeMember('NiaRD', 25);
        giveFriendsAndCopies(nia, bob);
        joinedThroughTheDoor(nia, 'door-hash-nia');
        const commonsBeforeN = getCommonsBalance();
        const niaDeletes = await call('POST', '/api/member/purge', nia, {});
        assert(niaDeletes.status === 200 && niaDeletes.body?.message === 'Account successfully purged from node.' && erased(nia.pk)
            && friendsOf(nia.pk) === 0 && copiesOf(nia.pk) === 0 && getBalance(nia.pk).balance === 0
            && Math.abs(getCommonsBalance() - (commonsBeforeN + 25)) < 1e-6,
            `Nia deletes her account as before: erased, friends and copies gone, her 25 Beans to the Commons (${show(niaDeletes)})`);
        assert(String(joinHashOf(nia.pk)).startsWith('released:') && openJoinTaken('door-hash-nia') === null,
            `and the sign-in account she joined with is released, so it can join again (${joinHashOf(nia.pk)})`);
        const proposal = await proposeReinstate(nia.pk);
        assert(proposal.status === 400 && proposal.body?.error === OWNER_DELETED, `a reinstate proposal for her is refused too (${show(proposal)})`);
    }

    // ── 5. Nobody deletes another key's row ────────────────────────────────────────────────────────
    console.log("\n── 5. Only the key itself deletes its row");
    {
        const ray = makeMember('RayRD', 10);
        giveFriendsAndCopies(ray, alice);
        adminPruneUser(ray.pk, 'owner:password');
        const mal = makeMember('MalRD', 10);
        const stranger = keypair('StrangerRD');
        const rows = () => [ray, mal, alice].map(m => wholeRow(m.pk)).join('\n');
        const before = rows();
        const naming = await call('POST', '/api/member/purge', mal, { publicKey: ray.pk });
        const namingMember = await call('POST', '/api/member/purge', mal, { memberPubkey: ray.pk, targetPubkey: alice.pk });
        const header = await send(signed('POST', '/api/member/purge', mal, {}, ray.pk));
        const none = await unsigned('/api/member/purge', { publicKey: ray.pk });
        const noRow = await call('POST', '/api/member/purge', stranger, { publicKey: stranger.pk });
        assert(naming.status === 403 && header.status === 403 && /Invalid cryptographic signature/.test(header.body?.error ?? '')
            && none.status === 401 && noRow.status === 400 && noRow.body?.error === 'Member not found',
            `a body naming Ray's key, Ray's key on Mal's signature, no signature and a key with no row are refused (${[naming, header, none, noRow].map(show).join(' | ')})`);
        // A body naming others where the route never reads it deletes only the signer: Mal, never Ray or Alice.
        assert(namingMember.status === 200 && statusOf(mal.pk) === 'pruned',
            `a body naming others deletes only the signer (${show(namingMember)})`);
        const after = [ray, alice].map(m => wholeRow(m.pk)).join('\n');
        assert(after === before.split('\n').filter((_, i) => i !== 1).join('\n') && !erased(ray.pk) && friendsOf(ray.pk) === 2 && copiesOf(ray.pk) === 2,
            `and Ray's and Alice's rows are exactly as they were (${JSON.stringify(profileOf(ray.pk))})`);
        // Ray's own request, captured and sent again: the second is refused as a replay, whatever the first did.
        const own = signed('POST', '/api/member/purge', ray, {});
        const first = await send(own);
        const replay = await send(own);
        assert(first.status === 200 && erased(ray.pk) && replay.status === 403 && /Replay detected/.test(replay.body?.error ?? ''),
            `Ray's own request erases his row once; sent again it is refused as a replay (${show(first)} | ${show(replay)})`);
    }

    // ── 6. A keeper deletes their account ──────────────────────────────────────────────────────────
    console.log('\n── 6. A keeper deletes their account: each enterprise they keep carries on, as when a keeper leaves');
    {
        // Lena leads an enterprise with Kit (longer serving) and Kai. Before she is removed she proposes removing Kai, and
        // asks to keep Mo's enterprise, whose lead approves her: both changes wait out their objection window.
        const lena = makeMember('LenaRD', 0), kit = makeMember('KitRD', 0), kai = makeMember('KaiRD', 0);
        const ent = makeEnterprise(lena, [kit, kai]);
        const removeKai = proposeKeeperRemoval(ent, lena.pk, kai.pk).change!;
        const mo = makeMember('MoRD', 0), max = makeMember('MaxRD', 0);
        const mos = makeEnterprise(mo, [max]);
        const ask = requestToJoinEnterprise(mos, lena.pk, 0);
        const addLena = approveKeeperRequest(ask.id, mo.pk).change!;
        adminPruneUser(lena.pk, 'owner:password');
        assert(roleIn(ent, lena.pk) === 'lead' && getLeadInactivity(ent).leadPubkey === lena.pk && changeOf(removeKai.id).status === 'pending'
            && changeOf(addLena.id).status === 'pending',
            'setup: the removal leaves Lena lead, whom the keepers could replace by succession, and her two keeper changes pending');
        const beansBefore = beansOf(ent, mos);
        const auditBefore6 = audit();

        const lenaDeletes = await call('POST', '/api/member/purge', lena, {});
        assert(lenaDeletes.status === 200 && erased(lena.pk), `Lena, removed, signs Delete account and her profile is erased (${show(lenaDeletes)})`);
        const lead = getLeadInactivity(ent);
        assert(roleIn(ent, lena.pk) === null && roleIn(ent, kit.pk) === 'lead' && lead.leadPubkey === kit.pk && lead.autoPromoted
            && roleIn(ent, kai.pk) === 'keeper' && pausedOf(ent).paused === 0,
            `Kit, the longest-serving keeper, becomes lead at once, marked auto-promoted, and the enterprise carries on (${JSON.stringify(keepersOf(ent))})`);
        const succession = await call('POST', `/api/enterprise/${ent}/succession/propose`, kai, { candidatePubkey: kai.pk });
        assert(succession.status === 200 && succession.body?.success === true,
            `so succession works again: Kai proposes himself as lead at once (${show(succession)})`);
        assert(changeOf(removeKai.id).status === 'failed' && changeOf(addLena.id).status === 'failed' && requestStatus(ask.id) === 'cancelled'
            && roleIn(mos, lena.pk) === null,
            `the keeper change she made, and the one that would have added her to Mo's enterprise, close now (${JSON.stringify([changeOf(removeKai.id), changeOf(addLena.id)])})`);
        const auditAfter6 = audit();
        assert(JSON.stringify(beansOf(ent, mos)) === JSON.stringify(beansBefore) && auditAfter6.ok && auditAfter6.drift === auditBefore6.drift,
            `no enterprise's Beans move, and the ledger audit is unchanged (${JSON.stringify(beansBefore)} → ${JSON.stringify(beansOf(ent, mos))})`);
    }
    {
        // Sol is the only keeper of an enterprise, and is removed.
        const sol = makeMember('SolRD', 0);
        const solo = makeEnterprise(sol, []);
        adminPruneUser(sol.pk, 'owner:password');
        const beansBefore = beansOf(solo);
        const solDeletes = await call('POST', '/api/member/purge', sol, {});
        const p = pausedOf(solo);
        assert(solDeletes.status === 200 && keepersOf(solo).length === 0 && p.paused === 1 && p.paused_by === sol.pk
            && JSON.stringify(beansOf(solo)) === JSON.stringify(beansBefore),
            `a removed sole keeper's Delete account pauses the enterprise, as when its last keeper leaves, its Beans kept (${show(solDeletes)}; ${JSON.stringify(p)})`);
    }
    {
        // Ada, a member in good standing, leads one enterprise with Ivy and Ian, and another alone. Before this change her own
        // Delete account left both with no lead too.
        const ada = makeMember('AdaRD', 15), ivy = makeMember('IvyRD', 0), ian = makeMember('IanRD', 0);
        const shared = makeEnterprise(ada, [ivy, ian]);
        const alone = makeEnterprise(ada, []);
        const beansBefore = beansOf(shared, alone);
        const commonsBeforeA = getCommonsBalance();
        const auditBeforeA = audit();
        const adaDeletes = await call('POST', '/api/member/purge', ada, {});
        assert(adaDeletes.status === 200 && erased(ada.pk), `Ada signs Delete account (${show(adaDeletes)})`);
        assert(roleIn(shared, ada.pk) === null && roleIn(shared, ivy.pk) === 'lead' && getLeadInactivity(shared).autoPromoted && pausedOf(shared).paused === 0,
            `her first enterprise goes to Ivy, the longest-serving keeper (${JSON.stringify(keepersOf(shared))})`);
        const p = pausedOf(alone);
        assert(keepersOf(alone).length === 0 && p.paused === 1 && p.paused_by === ada.pk, `the one she kept alone pauses (${JSON.stringify(p)})`);
        const succession = await call('POST', `/api/enterprise/${shared}/succession/propose`, ian, { candidatePubkey: ian.pk });
        assert(succession.status === 200, `and Ian can propose a new lead there (${show(succession)})`);
        const auditAfterA = audit();
        assert(JSON.stringify(beansOf(shared, alone)) === JSON.stringify(beansBefore) && Math.abs(getCommonsBalance() - (commonsBeforeA + 15)) < 1e-6
            && auditAfterA.ok && auditAfterA.drift === auditBeforeA.drift,
            `her own 15 Beans go to the Commons as before, the enterprises keep theirs, and the ledger audit is unchanged (${JSON.stringify(beansBefore)} → ${JSON.stringify(beansOf(shared, alone))})`);
    }
    {
        // Pia is an ordinary keeper under Gus, with a 10-Bean pledge, and Gus has proposed removing her.
        const gus = makeMember('GusRD', 0), pia = makeMember('PiaRD', 0), quin = makeMember('QuinRD', 0);
        const ent = makeEnterprise(gus, [pia, quin]);
        db.prepare('INSERT INTO enterprise_pledges (id, keeper, enterprise, amount) VALUES (?, ?, ?, 10)').run(crypto.randomUUID(), pia.pk, ent);
        const removePia = proposeKeeperRemoval(ent, gus.pk, pia.pk).change!;
        const beansBefore = beansOf(ent);
        const piaDeletes = await call('POST', '/api/member/purge', pia, {});
        const keepers = keepersOf(ent);
        assert(piaDeletes.status === 200 && roleIn(ent, pia.pk) === null && roleIn(ent, gus.pk) === 'lead' && roleIn(ent, quin.pk) === 'keeper'
            && keepers.every(k => k.auto_promoted_at === null) && pausedOf(ent).paused === 0,
            `a plain keeper's Delete account unbinds her and leaves Gus lead, nothing else changed (${JSON.stringify(keepers)})`);
        assert(pledgeOf(ent, pia.pk) === 0 && changeOf(removePia.id).status === 'failed' && JSON.stringify(beansOf(ent)) === JSON.stringify(beansBefore),
            `her pledge is released as when a keeper steps down, the change naming her closes, and the enterprise keeps its Beans (pledge ${pledgeOf(ent, pia.pk)}; ${JSON.stringify(changeOf(removePia.id))})`);
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(process.exitCode ?? 0);
}

main().catch(e => { console.error(e); process.exit(1); });
