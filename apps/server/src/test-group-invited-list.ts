/**
 * "Invited, not joined yet" on a group's page (Rob via Marty, 11 Nov 2026: "Invitations should show whether they have been
 * used"), for a PRIVATE group — and who may read it, over a REAL HTTPS round trip through the signature middleware
 * (GET /api/groups/:id/invitations, engine/group-invitations.ts). The server is the boundary: each viewer is answered only
 * what they may see.
 *
 * Verifies:
 *  1. A convenor sees every pending invitation, with who made it and when; another convenor sees the same.
 *  2. Any other member sees only the invitations THEY made (a convenor who was made a member since), and a member who made
 *     none sees none. A sender's own rows carry no `invitedBy`.
 *  3. Nobody else sees any: the invitee (403), someone who asked to join (403), a stranger to an invite-only group (404, as
 *     if it did not exist), a stranger to an open group (403), and an unsigned read (401). A suspended convenor reads as
 *     any other member does.
 *  4. Accepted: the person leaves the pending list for everyone and is a member. Withdrawn: gone for everyone, and no note
 *     is left. A convenor may withdraw anyone's; the sender may withdraw their own after losing the role; another member
 *     may not (403, and the invitation stands).
 *  5. Declined: shown ONLY to the member who made it, "Declined" and dated — not to the other convenor, not to a member,
 *     not to the person who declined (refused). Gone from the pending list for everyone. Declined when it was a
 *     convenor's and the sender is not the viewer: the viewing convenor sees nothing of it.
 *  6. Invited again, the "Declined" goes and the invitation is pending; a note older than DECLINE_KEPT_DAYS is not shown;
 *     leaving a group leaves no note.
 *  7. Who hears of it over the live feed (websocket): an invitation made, declined or withdrawn reaches only the group's
 *     convenors, the person invited and the sender — never a member who is none of those.
 *  8. A group its members closed has nothing to show.
 *
 * Nothing leaves this machine.
 */

// Self-signed cert in LAN mode → relax TLS verification for the test client only.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_ROLE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, addWsClient, removeWsClient } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { DECLINE_KEPT_DAYS, INVITATIONS_SHOWN } from './engine/group-invitations.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (!url.startsWith('https://localhost')) throw new Error(`test-group-invited-list: refused a request off this machine: ${url}`);
    return realFetch(input, init);
}) as typeof fetch;

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ FAIL: ${msg}`); }
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject; name: string };
const DAY = 86400_000;

function makeMember(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    const joinedAt = new Date(Date.now() - 30 * DAY).toISOString();
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, earned_credit_c) VALUES (?, ?, ?, 'active', 100)`).run(pubKeyHex, callsign, joinedAt);
    db.prepare(`INSERT INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 50, 0)`).run(pubKeyHex);
    return { pubKeyHex, privateKey, name: callsign };
}

/** A group led by `lead`; the rest active in it with the roles given. */
function makeGroup(name: string, joinPolicy: 'open' | 'request_to_join' | 'invite_only', lead: Id, others: Array<{ id: Id; role: 'convenor' | 'member' | 'observer' }> = []): string {
    const gid = crypto.randomUUID();
    const created = new Date(Date.now() - 10 * DAY).toISOString();
    db.prepare(`INSERT INTO groups (id, name, slug, category, created_by, lead_pubkey, join_policy, created_at, updated_at)
                VALUES (?, ?, ?, 'social', ?, ?, ?, ?, ?)`)
        .run(gid, name, `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${gid.slice(0, 6)}`, lead.pubKeyHex, lead.pubKeyHex, joinPolicy, created, created);
    for (const [i, p] of [{ id: lead, role: 'convenor' as const }, ...others].entries()) {
        const at = new Date(Date.now() - (9 - i * 0.1) * DAY).toISOString();
        db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status, joined_at, role_since, updated_at)
                    VALUES (?, ?, ?, 'active', ?, ?, ?)`).run(gid, p.id.pubKeyHex, p.role, at, at, at);
    }
    return gid;
}

type Signed = { status: number; body: any };

/** The replay-proof scheme the real middleware requires: method + path (without its query) + timestamp + nonce + body. */
async function signedFetch(method: 'GET' | 'POST' | 'DELETE' | 'PATCH', path: string, body: unknown, id: Id | null): Promise<Signed> {
    resetGatewayRateLimit();
    const bodyString = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pubKeyHex;
        headers['X-Signature'] = signRequest(id.privateKey, { method, path: path.split('?')[0], timestamp: ts, nonce, body: bodyString });
        headers[SIGNED_FOR_HEADER] = signedForHost();
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : bodyString });
    let json: any;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body: json };
}

const invite = (g: string, by: Id, who: Id, role = 'member') => signedFetch('POST', `/api/groups/${g}/members`, { targetPubkey: who.pubKeyHex, role }, by);
const accept = (g: string, who: Id) => signedFetch('POST', `/api/groups/${g}/join`, {}, who);
const removeFrom = (g: string, by: Id, who: Id) => signedFetch('DELETE', `/api/groups/${g}/members/${who.pubKeyHex}`, {}, by);
const setRole = (g: string, by: Id, who: Id, role: string) => signedFetch('PATCH', `/api/groups/${g}/members/${who.pubKeyHex}`, { role }, by);
const read = (g: string, who: Id | null) => signedFetch('GET', `/api/groups/${g}/invitations`, null, who);
const pendingNames = (r: Signed): string[] => (r.body?.pending ?? []).map((p: any) => p.callsign).sort();
const declinedNames = (r: Signed): string[] => (r.body?.declined ?? []).map((p: any) => p.callsign).sort();
const declineRows = (g: string) => (db.prepare('SELECT COUNT(*) AS c FROM group_invite_declines WHERE group_id = ?').get(g) as { c: number }).c;

async function main(): Promise<void> {
    console.log('\nA private group lists who is invited and has not joined, to those who may read it, over real HTTPS\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const [cleo, cas, gus, hal, mia, nat, ola, pia, zed, ivy] = ['Cleo', 'Cas', 'Gus', 'Hal', 'Mia', 'Nat', 'Ola', 'Pia', 'Zed', 'Ivy'].map(makeMember);
    // Cleo leads; Cas is a convenor; Gus and Hal are members.
    const garden = makeGroup('Secret Garden Club', 'invite_only', cleo, [{ id: cas, role: 'convenor' }, { id: gus, role: 'member' }, { id: hal, role: 'member' }]);

    // ── 1. A convenor sees every pending invitation, and who made it ──────────────────────────────────────────────
    assert((await invite(garden, cleo, mia)).status === 200, 'Cleo invites Mia');
    assert((await invite(garden, cas, nat)).status === 200, 'Cas invites Nat');
    const cleoView = await read(garden, cleo);
    assert(cleoView.status === 200 && cleoView.body?.view === 'convenor' && JSON.stringify(pendingNames(cleoView)) === JSON.stringify(['Mia', 'Nat']) && cleoView.body?.pendingTotal === 2,
        `a convenor sees both pending invitations, Mia and Nat (got ${cleoView.status} ${JSON.stringify(pendingNames(cleoView))})`);
    const byName = (r: Signed, who: string) => (r.body?.pending ?? []).find((p: any) => p.callsign === who);
    assert(byName(cleoView, 'Mia')?.invitedBy?.callsign === 'Cleo' && byName(cleoView, 'Nat')?.invitedBy?.callsign === 'Cas'
        && byName(cleoView, 'Mia')?.invitedBy?.pubkey === cleo.pubKeyHex && !Number.isNaN(Date.parse(byName(cleoView, 'Nat')?.invitedAt)),
        `and who made each (Mia by Cleo, Nat by Cas) and when (got ${JSON.stringify(byName(cleoView, 'Nat'))})`);
    const casView = await read(garden, cas);
    assert(casView.status === 200 && casView.body?.view === 'convenor' && JSON.stringify(pendingNames(casView)) === JSON.stringify(['Mia', 'Nat']),
        `another convenor sees the same two (got ${JSON.stringify(pendingNames(casView))})`);
    assert(cleoView.body?.declined?.length === 0, 'and no declined ones yet');

    // ── 2. Any other member sees only what they made ──────────────────────────────────────────────────────────────
    const gusView = await read(garden, gus);
    assert(gusView.status === 200 && gusView.body?.view === 'sender' && gusView.body?.pending?.length === 0 && gusView.body?.pendingTotal === 0 && gusView.body?.declined?.length === 0,
        `a member who made no invitation sees none, not the convenors' two (got ${JSON.stringify(gusView.body)})`);
    // Hal is made a convenor, invites Ola, and is made a member again: the invitation he made stands, and is his to see.
    assert((await setRole(garden, cleo, hal, 'convenor')).status === 200, 'Cleo makes Hal a convenor');
    assert((await invite(garden, hal, ola)).status === 200, 'Hal invites Ola');
    assert((await setRole(garden, cleo, hal, 'member')).status === 200, 'Cleo makes Hal a member again');
    const halView = await read(garden, hal);
    assert(halView.status === 200 && halView.body?.view === 'sender' && JSON.stringify(pendingNames(halView)) === JSON.stringify(['Ola']) && halView.body?.pendingTotal === 1,
        `Hal, a member now, sees only Ola, whom he invited: not Mia or Nat (got ${JSON.stringify(pendingNames(halView))})`);
    assert(halView.body.pending[0].invitedBy === undefined && !JSON.stringify(halView.body).includes(cleo.pubKeyHex) && !JSON.stringify(halView.body).includes(cas.pubKeyHex),
        "and his own row carries no 'invited by', and nothing of the convenors' invitations or keys is in the answer");
    assert(JSON.stringify(pendingNames(await read(garden, cleo))) === JSON.stringify(['Mia', 'Nat', 'Ola']), 'the convenors see Ola too');

    // A convenor whose account is suspended reads as any other member (the roster's rule): only what they made.
    db.prepare("UPDATE members SET status = 'disabled' WHERE public_key = ?").run(cas.pubKeyHex);
    const casSuspended = await read(garden, cas);
    assert(casSuspended.status === 200 && casSuspended.body?.view === 'sender' && JSON.stringify(pendingNames(casSuspended)) === JSON.stringify(['Nat']),
        `a suspended convenor sees only Nat, whom they made (got ${casSuspended.body?.view} ${JSON.stringify(pendingNames(casSuspended))})`);
    db.prepare("UPDATE members SET status = 'active' WHERE public_key = ?").run(cas.pubKeyHex);

    // ── 3. Nobody else sees any ───────────────────────────────────────────────────────────────────────────────────
    const miaRead = await read(garden, mia);
    assert(miaRead.status === 403 && !JSON.stringify(miaRead.body).includes('Nat') && miaRead.body?.pending === undefined,
        `the person invited is refused (403) and told nothing of the others (got ${miaRead.status})`);
    const zedRead = await read(garden, zed);
    const nowhere = await read(crypto.randomUUID(), zed);
    assert(zedRead.status === 404 && zedRead.status === nowhere.status && JSON.stringify(zedRead.body) === JSON.stringify(nowhere.body),
        `a stranger to an invite-only group gets the answer an id nobody has gets (404; got ${zedRead.status})`);
    db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status, joined_at, invited_by) VALUES (?, ?, 'member', 'pending_approval', ?, NULL)`)
        .run(garden, pia.pubKeyHex, new Date().toISOString());
    const piaRead = await read(garden, pia);
    assert(piaRead.status === 403 && piaRead.body?.pending === undefined, `someone who asked to join is refused (403; got ${piaRead.status})`);
    const openGroup = makeGroup('Open Choir', 'open', cleo, [{ id: gus, role: 'member' }]);
    assert((await invite(openGroup, cleo, mia)).status === 200, 'Cleo invites Mia to an open group');
    const zedOpen = await read(openGroup, zed);
    assert(zedOpen.status === 403 && zedOpen.body?.pending === undefined, `a stranger to an open group is refused (403; got ${zedOpen.status})`);
    assert((await read(garden, null)).status === 401, 'an unsigned read is refused (401)');
    assert((await read(openGroup, cleo)).status === 200 && JSON.stringify(pendingNames(await read(openGroup, cleo))) === JSON.stringify(['Mia']), 'a convenor of the open group sees its one invitation');
    assert(pendingNames(await read(openGroup, gus)).length === 0, "and a member of it sees none of the convenor's");
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND member_pubkey = ?').run(garden, pia.pubKeyHex);

    // ── 4. Accepted, withdrawn ────────────────────────────────────────────────────────────────────────────────────
    const joined = await accept(garden, nat);
    assert(joined.status === 200 && joined.body?.member?.status === 'active', `Nat accepts (got ${joined.status})`);
    for (const [who, label] of [[cleo, 'Cleo'], [cas, 'Cas']] as Array<[Id, string]>) {
        const v = await read(garden, who);
        assert(JSON.stringify(pendingNames(v)) === JSON.stringify(['Mia', 'Ola']) && v.body?.pendingTotal === 2, `accepted: Nat is off ${label}'s pending list (got ${JSON.stringify(pendingNames(v))})`);
    }
    const natView = await read(garden, nat);
    assert(natView.status === 200 && natView.body?.view === 'sender' && natView.body?.pending?.length === 0, "Nat, now a member, sees none of the others' invitations");
    const roster = await signedFetch('GET', `/api/groups/${garden}/members`, null, cleo);
    assert((roster.body ?? []).some((m: any) => m.callsign === 'Nat' && m.status === 'active'), 'and is a member in the roster');

    const refused = await removeFrom(garden, gus, ola);
    assert(refused.status === 403 && pendingNames(await read(garden, cleo)).includes('Ola'), `another member cannot withdraw Hal's invitation (403), and it stands (got ${refused.status})`);
    const halWithdraws = await removeFrom(garden, hal, ola);
    assert(halWithdraws.status === 200 && halWithdraws.body?.success === true, `Hal, no longer a convenor, withdraws his own invitation to Ola (got ${halWithdraws.status} ${halWithdraws.body?.error ?? ''})`);
    assert(JSON.stringify(pendingNames(await read(garden, cleo))) === JSON.stringify(['Mia']) && pendingNames(await read(garden, hal)).length === 0, 'Ola is off every list');
    assert(declineRows(garden) === 0, 'a withdrawn invitation leaves no "Declined" note');
    const cleoWithdraws = await removeFrom(garden, cleo, mia);
    assert(cleoWithdraws.status === 200 && pendingNames(await read(garden, cleo)).length === 0 && declineRows(garden) === 0,
        'a convenor withdraws Mia\'s: gone for everyone, and no note');
    assert((await accept(garden, mia)).status !== 200, 'a withdrawn invitation cannot be accepted');

    // ── 5. Declined: for the member who made it, and nobody else ──────────────────────────────────────────────────
    assert((await invite(garden, cleo, mia)).status === 200 && (await invite(garden, cas, ola)).status === 200, 'Cleo invites Mia again and Cas invites Ola');
    // Mia declines (her own removal of an invitation).
    const miaDeclines = await removeFrom(garden, mia, mia);
    assert(miaDeclines.status === 200 && miaDeclines.body?.success === true, `Mia declines (got ${miaDeclines.status})`);
    const cleoAfter = await read(garden, cleo);
    assert(JSON.stringify(declinedNames(cleoAfter)) === JSON.stringify(['Mia']) && !Number.isNaN(Date.parse(cleoAfter.body.declined[0].declinedAt))
        && cleoAfter.body.declined[0].memberPubkey === mia.pubKeyHex && JSON.stringify(pendingNames(cleoAfter)) === JSON.stringify(['Ola']),
        `Cleo, who invited her, sees "Declined" for Mia, dated, and Mia is off the pending list (got ${JSON.stringify(cleoAfter.body)})`);
    const casAfter = await read(garden, cas);
    assert(casAfter.body?.declined?.length === 0 && !JSON.stringify(casAfter.body).includes('Mia') && JSON.stringify(pendingNames(casAfter)) === JSON.stringify(['Ola']),
        `Cas, another convenor, sees nothing of it (got ${JSON.stringify(casAfter.body)})`);
    for (const [who, label] of [[gus, 'Gus'], [hal, 'Hal'], [nat, 'Nat']] as Array<[Id, string]>) {
        const v = await read(garden, who);
        assert(v.status === 200 && v.body?.declined?.length === 0 && !JSON.stringify(v.body).includes('Mia'), `${label}, a member, sees nothing of it`);
    }
    const miaAfter = await read(garden, mia);
    assert(miaAfter.status === 404 || miaAfter.status === 403, `Mia, who declined, is refused (got ${miaAfter.status})`);
    assert(miaAfter.body?.declined === undefined && miaAfter.body?.pending === undefined, 'and is shown nothing');
    // Cas declines his own to be sure the rule is the sender's, not the lead's: Ola declines Cas's invitation.
    assert((await removeFrom(garden, ola, ola)).status === 200, 'Ola declines the invitation Cas made');
    const casSees = await read(garden, cas);
    const cleoSees = await read(garden, cleo);
    assert(JSON.stringify(declinedNames(casSees)) === JSON.stringify(['Ola']) && JSON.stringify(declinedNames(cleoSees)) === JSON.stringify(['Mia']),
        `each sender sees only theirs: Cas "Declined" for Ola, Cleo for Mia (got Cas ${JSON.stringify(declinedNames(casSees))}, Cleo ${JSON.stringify(declinedNames(cleoSees))})`);

    // ── 6. Invited again; a note that has aged; leaving ────────────────────────────────────────────────────────
    assert((await invite(garden, cleo, mia)).status === 200, 'Cleo invites Mia a third time');
    const again = await read(garden, cleo);
    assert(JSON.stringify(pendingNames(again)) === JSON.stringify(['Mia']) && declinedNames(again).length === 0 && declineRows(garden) === 1,
        `invited again: Mia is pending and the "Declined" for her has gone (Ola's, Cas's, stays) (got ${JSON.stringify(again.body)})`);
    db.prepare("UPDATE group_invite_declines SET declined_at = ? WHERE group_id = ? AND invitee_pubkey = ?")
        .run(new Date(Date.now() - (DECLINE_KEPT_DAYS + 1) * DAY).toISOString(), garden, ola.pubKeyHex);
    assert(declinedNames(await read(garden, cas)).length === 0, `a note older than ${DECLINE_KEPT_DAYS} days is not shown`);
    db.prepare("UPDATE group_invite_declines SET declined_at = ? WHERE group_id = ? AND invitee_pubkey = ?")
        .run(new Date(Date.now() - (DECLINE_KEPT_DAYS - 1) * DAY).toISOString(), garden, ola.pubKeyHex);
    assert(JSON.stringify(declinedNames(await read(garden, cas))) === JSON.stringify(['Ola']), `and one a day younger than that still is`);
    // Mia joins, then leaves: a leaving is no decline, and leaves no note for Cleo.
    assert((await accept(garden, mia)).status === 200 && (await removeFrom(garden, mia, mia)).status === 200, 'Mia joins and then leaves');
    const afterLeave = await read(garden, cleo);
    assert(afterLeave.body?.declined?.length === 0 && afterLeave.body?.pending?.length === 0, `a member leaving leaves no "Declined" and nothing pending (got ${JSON.stringify(afterLeave.body)})`);
    // A person who is back in the group (invited by someone else after declining) is not shown as declined.
    db.prepare(`INSERT OR REPLACE INTO group_invite_declines (group_id, invitee_pubkey, invited_by, invited_at, declined_at) VALUES (?, ?, ?, ?, ?)`)
        .run(garden, nat.pubKeyHex, cleo.pubKeyHex, new Date().toISOString(), new Date().toISOString());
    assert(declinedNames(await read(garden, cleo)).length === 0, "a stale note for someone who is a member now is not shown");
    db.prepare('DELETE FROM group_invite_declines WHERE group_id = ?').run(garden);

    // ── 7. The live feed: only the convenors, the person invited and the sender hear of it ────────────────────
    const heard: Record<string, any[]> = {};
    const sockets = [cleo, cas, gus, hal, nat, ivy, zed].map(id => {
        heard[id.name] = [];
        const ws: any = { _memberPubkey: id.pubKeyHex, _memberFeed: true, send: (m: string) => heard[id.name].push(JSON.parse(m)) };
        addWsClient(ws);
        return ws;
    });
    const reset = () => { for (const k of Object.keys(heard)) heard[k].length = 0; };
    const heardOf = (type: string) => Object.keys(heard).filter(k => heard[k].some(e => e.type === type)).sort();
    reset();
    assert((await setRole(garden, cleo, hal, 'convenor')).status === 200, 'Hal is a convenor again');
    assert((await setRole(garden, cleo, hal, 'member')).status === 200, 'and a member');
    reset();
    assert((await invite(garden, cas, ivy)).status === 200, 'Cas invites Ivy');
    assert(JSON.stringify(heardOf('group_member_invited')) === JSON.stringify(['Cas', 'Cleo', 'Ivy']),
        `an invitation made reaches the convenors and Ivy, not Gus, Hal, Nat or Zed (got ${heardOf('group_member_invited').join(', ')})`);
    reset();
    assert((await removeFrom(garden, ivy, ivy)).status === 200, 'Ivy declines');
    assert(JSON.stringify(heardOf('group_member_removed')) === JSON.stringify(['Cas', 'Cleo', 'Ivy']),
        `a decline reaches the convenors and Ivy — not Gus, Hal, Nat or Zed (got ${heardOf('group_member_removed').join(', ')})`);
    reset();
    assert((await invite(garden, cleo, ivy)).status === 200 && (await removeFrom(garden, cleo, ivy)).status === 200, 'Cleo invites Ivy and withdraws it');
    assert(JSON.stringify(heardOf('group_member_removed')) === JSON.stringify(['Cas', 'Cleo', 'Ivy']),
        `a withdrawal reaches the same, and no member (got ${heardOf('group_member_removed').join(', ')})`);
    reset();
    // A member leaving is still the group's business.
    assert((await removeFrom(garden, nat, nat)).status === 200, 'Nat leaves');
    assert(heardOf('group_member_removed').includes('Gus') && heardOf('group_member_removed').includes('Hal'), `a member leaving still reaches the members (got ${heardOf('group_member_removed').join(', ')})`);
    for (const ws of sockets) removeWsClient(ws);

    // ── 8. A closed group has nothing to show ─────────────────────────────────────────────────────────────────────
    const closing = makeGroup('Closing Circle', 'invite_only', cleo, [{ id: gus, role: 'member' }]);
    assert((await invite(closing, cleo, zed)).status === 200 && pendingNames(await read(closing, cleo)).length === 1, 'Cleo invites Zed to a group that is open to invitations');
    db.prepare("INSERT INTO group_closures (group_id, closed_at, decision_id) VALUES (?, ?, 'test-decision')").run(closing, new Date().toISOString());
    const closed = await read(closing, cleo);
    assert(closed.status === 200 && closed.body?.pending?.length === 0 && closed.body?.pendingTotal === 0 && closed.body?.declined?.length === 0,
        `a group its members closed has nothing to show (got ${JSON.stringify(closed.body)})`);

    // ── 9. A big group: the answer is bounded, and the count is whole ───────────────────────────────────────────
    const wave = makeGroup('Big Choir', 'invite_only', cleo);
    const insertMember = db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, earned_credit_c) VALUES (?, ?, ?, 'active', 100)`);
    const insertInvite = db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status, joined_at, invited_by) VALUES (?, ?, 'member', 'invited', ?, ?)`);
    db.transaction(() => {
        for (let i = 0; i < INVITATIONS_SHOWN + 25; i++) {
            const key = crypto.randomBytes(32).toString('hex');
            insertMember.run(key, `Wave${i}`, new Date(Date.now() - 30 * DAY).toISOString());
            insertInvite.run(wave, key, new Date(Date.now() - i * 1000).toISOString(), cleo.pubKeyHex);
        }
    })();
    const big = await read(wave, cleo);
    assert(big.status === 200 && big.body?.pending?.length === INVITATIONS_SHOWN && big.body?.pendingTotal === INVITATIONS_SHOWN + 25 && big.body.pending[0].callsign === 'Wave0',
        `${INVITATIONS_SHOWN + 25} pending: ${INVITATIONS_SHOWN} rows, newest first, and the whole count (got ${big.body?.pending?.length} of ${big.body?.pendingTotal})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ EACH VIEWER SEES ONLY THE INVITATIONS THEY MAY.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
