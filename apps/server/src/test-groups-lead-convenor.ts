/**
 * Groups get a lead convenor (Marty's decision, 2026-09-23).
 *
 * Damo was made a convenor of "martys group" and found he could remove the group's creator. A group now has ONE
 * lead convenor, and this suite is the rule set:
 *
 *  1. Any convenor still approves, invites and removes members and observers, promotes someone to convenor,
 *     removes posts and messages, and edits the group and its join policy.
 *  2. Only the lead can remove or demote a convenor.
 *  3. NOBODY can remove or demote the lead. Node admins have no power over groups and gain none here.
 *  4. Hand over: the lead makes another active convenor the lead, or an active member, who becomes a convenor in
 *     the same step. The outgoing lead stays a convenor.
 *  5. Step down and leave: the lead hands over first while anyone else is active; the last one out may just go.
 *  6. The 30-day-silence vote covers a silent LEAD, not only a sole convenor: the other convenors vote, or the
 *     members when the lead is the group's only convenor.
 *  7. The stored lead (`groups.lead_pubkey`) is what travels — in the group APIs and in replication — and the
 *     backfill rule decides for a group whose column was never written.
 *  8. The routes: statuses, invite-only still hidden, and POST /api/groups/:id/lead.
 *
 * Local only — it touches no node. Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-groups-lead-convenor.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { db } from './db/db.js';
import {
    initStateEngine, createGroup, getGroup, listGroups, joinGroup, setMemberRole, removeGroupMember,
    inviteGroupMember, approveGroupMember, updateGroup, updateGroupPolicy, getGroupLead, isGroupLead,
    handOverGroupLead, getGroupSuccession, proposeGroupConvenor, voteGroupConvenor, exportSyncState,
    GroupSystemType,
} from './state-engine.js';
import { createGroupRoutes } from './routes/groups.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
}
function assertThrows(fn: () => unknown, match: RegExp, msg: string): void {
    run++;
    try {
        fn();
        console.error(`✗ FAIL: ${msg} (nothing thrown — the action was ALLOWED)`);
    } catch (e: any) {
        if (match.test(e?.message ?? '')) { passed++; console.log(`✓ ${msg}`); }
        else console.error(`✗ FAIL: ${msg} (got "${e?.message}")`);
    }
}

const DAY = 24 * 60 * 60 * 1000;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';

function makeMember(callsign: string): string {
    const pub = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, avatar_url, status, updated_at)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
        .run(pub, callsign, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pub);
    return pub;
}
/** Make a member look silent: no activity (and no joining) for `days` days. */
function silence(pub: string, days = 31): void {
    const then = new Date(Date.now() - days * DAY).toISOString();
    db.prepare('UPDATE members SET last_active_at = ?, joined_at = ? WHERE public_key = ?').run(then, then, pub);
}
const role = (g: string, pk: string) =>
    (db.prepare('SELECT role FROM group_members WHERE group_id = ? AND member_pubkey = ?').get(g, pk) as any)?.role;
const storedLead = (g: string) =>
    (db.prepare('SELECT lead_pubkey FROM groups WHERE id = ?').get(g) as any)?.lead_pubkey ?? null;
const lastLine = (g: string) => db.prepare(
    "SELECT system_type, ciphertext FROM messages WHERE conversation_id = ? AND type = 'system' ORDER BY rowid DESC LIMIT 1"
).get(g) as any;

/** A group with an open join policy: its creator (the first lead convenor) plus the given members. */
function groupOf(name: string, creator: string, members: string[]): string {
    const g = createGroup({ name, joinPolicy: 'open', createdBy: creator });
    for (const m of members) joinGroup(g.id, m);
    return g.id;
}

async function dispatch(router: any, method: string, path: string, actor: string | undefined, body?: any) {
    const matched = router.match(path, method);
    const layer = matched.pathAndMethod.find((l: any) => l.methods.includes(method));
    if (!layer) throw new Error(`No route found for ${method} ${path}`);
    const m = path.match(layer.regexp);
    const params: Record<string, string> = {};
    (layer.paramNames || []).forEach((p: any, i: number) => { params[p.name] = decodeURIComponent(m?.[i + 1] ?? ''); });
    const ctx: any = {
        params, requestBody: body ?? {}, state: actor ? { actor } : {}, query: {},
        get: () => '', set: () => { }, headers: {},
    };
    await layer.stack[layer.stack.length - 1](ctx);
    return ctx;
}

async function main(): Promise<void> {
    initStateEngine();
    const router = createGroupRoutes({
        checkAdminAuth: async () => true, rateLimit: () => true,
        clampLimit: (n: any) => Number(n) || 50, clampOffset: (n: any) => Number(n) || 0,
        activeConnections: new Map(), calculateAnalytics: () => ({}), enforceReadAuth: true,
    } as any);

    // ── 1. The creator is the first lead convenor ───────────────────────────────────────────────
    console.log('\n--- 1. The creator leads the group they made ---');
    const marty = makeMember('Marty Party2');
    const damo = makeMember('Damo');
    const cass = makeMember('Cass');
    const obs = makeMember('Obi');
    const outsider = makeMember('Outsider');
    const g1 = groupOf('martys group', marty, [damo, cass, obs]);

    assert(storedLead(g1) === marty, 'the creator is written down as the lead, not inferred');
    assert(getGroupLead(g1) === marty && isGroupLead(g1, marty), 'and read back as the lead');
    assert(isGroupLead(g1, damo) === false, 'a member is not the lead');
    assert(getGroup(g1)!.leadPubkey === marty && getGroup(g1)!.leadCallsign === 'Marty Party2',
        'the group API carries leadPubkey and leadCallsign');
    assert(listGroups({ memberPubkey: marty }, marty).find(g => g.id === g1)?.leadPubkey === marty,
        'the groups list carries it too');

    // ── 2. Damo's bug: a convenor cannot remove or demote the group's lead ──────────────────────
    console.log("\n--- 2. Damo is a convenor now. He cannot touch Marty ---");
    setMemberRole(g1, marty, damo, 'convenor');        // any convenor may promote; here the lead does
    setMemberRole(g1, marty, obs, 'observer');
    assert(role(g1, damo) === 'convenor', 'Damo is a convenor');
    assert(getGroupLead(g1) === marty, 'promoting a convenor does not move the lead');

    assertThrows(() => removeGroupMember(g1, damo, marty), /lead convenor cannot be removed/,
        'a convenor CANNOT remove the group\'s lead — the bug Damo found');
    assertThrows(() => setMemberRole(g1, damo, marty, 'member'), /lead convenor cannot be demoted/,
        'nor demote them to a member');
    assertThrows(() => setMemberRole(g1, damo, marty, 'observer'), /lead convenor cannot be demoted/,
        'nor to an observer');
    assert(role(g1, marty) === 'convenor' && getGroupLead(g1) === marty, 'Marty is untouched after all three');

    // ── 3. Only the lead touches another convenor ───────────────────────────────────────────────
    console.log('\n--- 3. Convenor on convenor ---');
    setMemberRole(g1, marty, cass, 'convenor');
    assertThrows(() => setMemberRole(g1, damo, cass, 'member'), /Only this group's lead convenor/,
        'a convenor cannot demote another convenor');
    assertThrows(() => removeGroupMember(g1, damo, cass), /Only this group's lead convenor/,
        'nor remove them');
    assert(role(g1, cass) === 'convenor', 'Cass is still a convenor');
    assert(setMemberRole(g1, marty, cass, 'member').role === 'member', 'the LEAD demotes a convenor');
    setMemberRole(g1, marty, cass, 'convenor');
    assert(removeGroupMember(g1, marty, cass) === true, 'and the LEAD removes a convenor');

    // ── 4. Everything a convenor could always do, they still can ───────────────────────────────
    console.log('\n--- 4. A convenor still runs the group ---');
    const req = makeMember('Asker');
    const inv = makeMember('Invitee');
    updateGroupPolicy(g1, damo, 'request_to_join');
    assert(getGroup(g1)!.joinPolicy === 'request_to_join', 'a convenor changes the join policy');
    assert(updateGroup(g1, damo, { description: 'Marty and friends' }).description === 'Marty and friends',
        'and edits the group');
    joinGroup(g1, req);
    assert(approveGroupMember(g1, damo, req).status === 'active', 'and approves a request');
    assert(inviteGroupMember(g1, damo, inv).status === 'invited', 'and invites someone');
    assert(removeGroupMember(g1, damo, inv) === true, 'and withdraws an invitation');
    assert(setMemberRole(g1, damo, req, 'observer').role === 'observer', 'and changes a member\'s role');
    assert(removeGroupMember(g1, damo, req) === true, 'and removes a member');
    assert(setMemberRole(g1, damo, obs, 'convenor').role === 'convenor', 'and promotes someone to convenor');
    // A convenor-in-waiting is not an active convenor, so any convenor may still withdraw the invitation.
    const waiting = makeMember('Waiting');
    inviteGroupMember(g1, damo, waiting, 'convenor');
    assert(removeGroupMember(g1, damo, waiting) === true, 'and withdraws an invitation that offered convenor');
    setMemberRole(g1, marty, obs, 'observer');
    updateGroupPolicy(g1, marty, 'open');

    // A member and an outsider are refused as before.
    assertThrows(() => setMemberRole(g1, obs, damo, 'member'), /UNAUTHORIZED: Only a group convenor/,
        'an observer changes nobody\'s role');
    assertThrows(() => removeGroupMember(g1, outsider, damo), /UNAUTHORIZED/, 'an outsider removes nobody');

    // ── 5. Hand over ───────────────────────────────────────────────────────────────────────────
    console.log('\n--- 5. Handing the lead over ---');
    assertThrows(() => handOverGroupLead(g1, damo, obs), /UNAUTHORIZED.*hand the lead over/,
        'only the lead hands the lead over');
    assertThrows(() => handOverGroupLead(g1, marty, obs), /observer only watches/,
        'not to an observer — promote them first');
    assertThrows(() => handOverGroupLead(g1, marty, outsider), /active member of this group/,
        'nor to somebody outside the group');
    assertThrows(() => handOverGroupLead(g1, marty, marty), /already lead this group/, 'nor to yourself');

    const handed = handOverGroupLead(g1, marty, damo);
    assert(handed.role === 'convenor' && getGroupLead(g1) === damo && storedLead(g1) === damo,
        'Damo is the lead now, written down');
    assert(role(g1, marty) === 'convenor', 'and Marty stays a convenor — handing over is not leaving');
    assert(lastLine(g1)?.system_type === GroupSystemType.LEAD_HANDED_OVER
        && /Marty Party2 made Damo the group's lead convenor/.test(lastLine(g1).ciphertext),
        'the chat says who handed the lead to whom');
    // The powers moved with it, both ways.
    assertThrows(() => removeGroupMember(g1, marty, damo), /lead convenor cannot be removed/,
        'Marty cannot remove the new lead');
    assert(removeGroupMember(g1, damo, marty) === true, 'and the new lead can remove the old one');

    // Handing over to an active MEMBER makes them a convenor in the same step.
    const pia = makeMember('Pia');
    joinGroup(g1, pia);
    assert(role(g1, pia) === 'member', 'Pia joins as a member');
    assert(handOverGroupLead(g1, damo, pia).role === 'convenor', 'handing the lead to a member makes them a convenor');
    assert(getGroupLead(g1) === pia, 'and the lead');

    // ── 6. Step down and leave ─────────────────────────────────────────────────────────────────
    console.log('\n--- 6. A lead stepping down, and leaving ---');
    const alone = makeMember('Solo');
    const withMe = makeMember('WithMe');
    const g2 = groupOf('Crowded', alone, [withMe]);
    assertThrows(() => removeGroupMember(g2, alone, alone), /[Hh]and the lead over/,
        'a lead cannot leave while somebody else is active');
    assertThrows(() => setMemberRole(g2, alone, alone, 'member'), /[Hh]and the lead over/,
        'nor step down from convenor');
    handOverGroupLead(g2, alone, withMe);
    assert(removeGroupMember(g2, alone, alone) === true, 'once handed over, they leave freely');
    assert(getGroupLead(g2) === withMe, 'the group still has its lead');

    const g3 = groupOf('Empty Soon', alone, []);
    assert(removeGroupMember(g3, alone, alone) === true, 'the last one in a group may just go');
    assert(getGroupLead(g3) === null && storedLead(g3) === null, 'and the group is left with no lead');

    // ── 7. Node admins have no say ─────────────────────────────────────────────────────────────
    console.log('\n--- 7. A node admin is nobody here ---');
    const admin = makeMember('Admin');
    db.prepare("INSERT OR REPLACE INTO node_roles (member_pubkey, role) VALUES (?, 'admin')").run(admin);
    assertThrows(() => removeGroupMember(g1, admin, pia), /UNAUTHORIZED/,
        'an admin who is not in the group removes nobody from it');
    joinGroup(g1, admin);
    setMemberRole(g1, pia, admin, 'convenor');
    assertThrows(() => removeGroupMember(g1, admin, pia), /lead convenor cannot be removed/,
        'and an admin who IS a convenor still cannot remove the lead');

    // ── 8. The backfill rule ───────────────────────────────────────────────────────────────────
    console.log('\n--- 8. The backfill: creator present, creator gone ---');
    const bc = makeMember('BackfillCreator');
    const bx = makeMember('BackfillOne');
    const by = makeMember('BackfillTwo');
    const g4 = groupOf('Creator Present', bc, [bx, by]);
    setMemberRole(g4, bc, bx, 'convenor');
    db.prepare('UPDATE groups SET lead_pubkey = NULL WHERE id = ?').run(g4);
    assert(getGroupLead(g4) === bc, 'creator present and an active convenor: the creator leads');

    const g5 = groupOf('Creator Gone', bc, [bx, by]);
    setMemberRole(g5, bc, bx, 'convenor');
    setMemberRole(g5, bc, by, 'convenor');
    handOverGroupLead(g5, bc, bx);
    removeGroupMember(g5, bc, bc);
    db.prepare('UPDATE groups SET lead_pubkey = NULL WHERE id = ?').run(g5);
    db.prepare("UPDATE group_members SET joined_at = '2020-01-01T00:00:00.000Z' WHERE group_id = ? AND member_pubkey = ?")
        .run(g5, by);
    assert(getGroupLead(g5) === by, 'creator gone: the longest-serving active convenor leads');

    // A stored lead who is no longer an active convenor is never read as the lead.
    db.prepare('UPDATE groups SET lead_pubkey = ? WHERE id = ?').run(bc, g5);
    assert(getGroupLead(g5) === by, 'a stale lead_pubkey is not read as a live lead');

    // And the migration itself, run on a table that predates the column.
    console.log('\n--- 8b. The migration statement on a pre-change table ---');
    const mig = new (await import('better-sqlite3')).default(':memory:');
    mig.exec(`
        CREATE TABLE groups (id TEXT PRIMARY KEY, created_by TEXT NOT NULL, lead_pubkey TEXT);
        CREATE TABLE group_members (group_id TEXT, member_pubkey TEXT, role TEXT, status TEXT, joined_at TEXT);
        INSERT INTO groups (id, created_by) VALUES ('present', 'creator'), ('gone', 'creator'), ('noconvenor', 'creator');
        INSERT INTO group_members VALUES
            ('present', 'creator', 'convenor', 'active', '2021-01-01'),
            ('present', 'early',   'convenor', 'active', '2020-01-01'),
            ('gone',    'early',   'convenor', 'active', '2020-01-01'),
            ('gone',    'later',   'convenor', 'active', '2022-01-01'),
            ('gone',    'creator', 'member',   'active', '2019-01-01'),
            ('noconvenor', 'someone', 'member', 'active', '2020-01-01');
    `);
    const changed = mig.prepare(`
        UPDATE groups SET lead_pubkey = COALESCE(
            (SELECT gmc.member_pubkey FROM group_members gmc
              WHERE gmc.group_id = groups.id AND gmc.member_pubkey = groups.created_by
                AND gmc.role = 'convenor' AND gmc.status = 'active'),
            (SELECT gmf.member_pubkey FROM group_members gmf
              WHERE gmf.group_id = groups.id AND gmf.role = 'convenor' AND gmf.status = 'active'
              ORDER BY gmf.joined_at ASC, gmf.member_pubkey ASC
              LIMIT 1)
        )
        WHERE lead_pubkey IS NULL
          AND EXISTS (SELECT 1 FROM group_members gm
                      WHERE gm.group_id = groups.id AND gm.role = 'convenor' AND gm.status = 'active')
    `).run();
    const leadOf = (id: string) => (mig.prepare('SELECT lead_pubkey FROM groups WHERE id = ?').get(id) as any).lead_pubkey;
    assert(changed.changes === 2, 'the backfill touches only groups that have an active convenor and no lead');
    assert(leadOf('present') === 'creator', 'the creator wins even over a longer-serving convenor');
    assert(leadOf('gone') === 'early', 'creator not a convenor: the longest-serving active convenor');
    assert(leadOf('noconvenor') === null, 'a group with no active convenor keeps a null lead');
    mig.close();

    // ── 9. The silence vote, now about the LEAD ────────────────────────────────────────────────
    console.log('\n--- 9. A silent lead with other convenors: the convenors vote ---');
    const sl = makeMember('SilentLead');
    const c1 = makeMember('Conv1');
    const c2 = makeMember('Conv2');
    const mm = makeMember('JustAMember');
    const g6 = groupOf('Two Convenors', sl, [c1, c2, mm]);
    setMemberRole(g6, sl, c1, 'convenor');
    setMemberRole(g6, sl, c2, 'convenor');
    silence(sl);

    const view6 = getGroupSuccession(g6, c1);
    assert(view6.silence.convenorPubkey === sl, 'the vote is about the lead');
    assert(view6.silence.electorate === 'convenors' && view6.silence.isEligible === true,
        'with other convenors present, THEY are the electorate — before this change no vote could open at all');
    assert(getGroupSuccession(g6, mm).canPropose === false, 'an ordinary member does not vote when convenors do');
    assertThrows(() => proposeGroupConvenor(g6, mm, c1), /Only an active convenor/,
        'and cannot propose');
    assertThrows(() => proposeGroupConvenor(g6, c1, mm), /candidate must be an active convenor/,
        'nor stand as the candidate');
    const p6 = proposeGroupConvenor(g6, c1, c2);
    assert(p6.proposal.electorateSize === 2 && p6.proposal.yesCount === 1, 'two convenors may vote; the proposal is one yes');
    assert(/proposed Conv2 as lead convenor/.test(lastLine(g6).ciphertext), 'the chat says it is about the lead');
    const done6 = voteGroupConvenor(p6.proposal.id, c2, 'yes');
    assert(done6.executed === true, 'two of two yes: it passes');
    assert(getGroupLead(g6) === c2 && storedLead(g6) === c2, 'Conv2 is the lead, written down');
    assert(role(g6, sl) === 'convenor',
        'the silent lead keeps the convenor role — the convenors took the lead off them, not the role');
    assert(/Convenors chose Conv2 as lead convenor \(2 yes, 0 no\)/.test(lastLine(g6).ciphertext),
        'and the chat says who chose');
    // The new lead's powers are real.
    assert(removeGroupMember(g6, c2, sl) === true, 'the new lead can remove the old one');

    console.log('\n--- 9b. A silent lead who is the only convenor: the members vote, as before ---');
    const only = makeMember('OnlyConvenor');
    const m1 = makeMember('Mem1');
    const m2 = makeMember('Mem2');
    const g7 = groupOf('One Convenor', only, [m1, m2]);
    silence(only);
    const view7 = getGroupSuccession(g7, m1);
    assert(view7.silence.electorate === 'members' && view7.silence.isEligible === true,
        'no other convenor: the members vote');
    const p7 = proposeGroupConvenor(g7, m1, m1);
    voteGroupConvenor(p7.proposal.id, m2, 'yes');
    assert(getGroupLead(g7) === m1, 'Mem1 leads the group now');
    assert(role(g7, only) === 'member',
        'and the silent convenor becomes an ordinary member, exactly as before the lead convenor existed');

    console.log('\n--- 9c. Cancellation and a lead nobody can replace ---');
    const back = makeMember('ComesBack');
    const bm1 = makeMember('BackMem1');
    const bm2 = makeMember('BackMem2');
    const g8 = groupOf('Returner', back, [bm1, bm2]);
    silence(back);
    const p8 = proposeGroupConvenor(g8, bm1, bm2);
    handOverGroupLead(g8, back, bm1);   // the group settles it itself
    assertThrows(() => voteGroupConvenor(p8.proposal.id, bm2, 'yes'), /closed/,
        'the lead changing closes the open vote');
    assert((db.prepare('SELECT closed_reason FROM group_convenor_proposals WHERE id = ?')
        .get(p8.proposal.id) as any).closed_reason === 'no_longer_needed', 'recorded as no_longer_needed');

    const lonely = makeMember('Lonely');
    const g9 = groupOf('Alone', lonely, []);
    silence(lonely);
    assert(getGroupSuccession(g9, lonely).silence.isEligible === false,
        'a lead alone in their group has no electorate, so no vote can open');
    assertThrows(() => proposeGroupConvenor(g9, lonely, lonely), /Nobody else in this group/, 'and proposing says so');

    // ── 10. lead_pubkey travels: replication, and the file backup ───────────────────────────────
    console.log('\n--- 10. Replication and backup carry the lead ---');
    const payload = await exportSyncState('test-node');
    const g6Sync = payload.groups?.find(g => g.id === g6);
    assert(g6Sync?.leadPubkey === c2, 'the sync payload carries leadPubkey');
    assert(payload.groups?.every(g => 'leadPubkey' in g) === true, 'on every group in the payload');

    // A replica importing it takes the lead with the group.
    // The round trip through a replica — export on one node, import on another — is asserted in
    // test-groups-sync-and-removal, which already has a P2P node up to sign the payload with.

    // The file backup is state.db itself, so the column is in it by construction — assert that, rather than
    // trusting it: the restore path replaces the database file and then re-runs the migrations above.
    const cols = (db.prepare('PRAGMA table_info(groups)').all() as any[]).map(c => c.name);
    assert(cols.includes('lead_pubkey'), 'groups.lead_pubkey is a column of state.db, which is what a backup is');

    // ── 11. The routes ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- 11. HTTP ---');
    const ra = makeMember('RouteLead');
    const rb = makeMember('RouteConvenor');
    const rc = makeMember('RouteMember');
    const g10 = groupOf('Routes', ra, [rb, rc]);
    setMemberRole(g10, ra, rb, 'convenor');

    assert((await dispatch(router, 'DELETE', `/api/groups/${g10}/members/${ra}`, rb)).status === 403,
        'a convenor removing the lead over HTTP is 403');
    assert((await dispatch(router, 'PATCH', `/api/groups/${g10}/members/${ra}`, rb, { role: 'member' })).status === 403,
        'demoting the lead is 403');
    assert((await dispatch(router, 'DELETE', `/api/groups/${g10}/members/${rc}`, rb)).status === 200,
        'and a convenor removing a member is still 200');

    assert((await dispatch(router, 'POST', `/api/groups/${g10}/lead`, ra, {})).status === 400,
        'a hand-over needs a target');
    assert((await dispatch(router, 'POST', `/api/groups/${g10}/lead`, rb, { targetPubkey: rb })).status === 403,
        'only the lead may hand the lead over: 403');
    assert((await dispatch(router, 'POST', `/api/groups/${g10}/lead`, undefined, { targetPubkey: rb })).status === 401,
        'unsigned: 401');
    const handedHttp = await dispatch(router, 'POST', `/api/groups/${g10}/lead`, ra, { targetPubkey: rb });
    assert(handedHttp.body?.success === true && getGroupLead(g10) === rb, 'the lead hands over: 200');
    const leaving = await dispatch(router, 'DELETE', `/api/groups/${g10}/members/${rb}`, rb);
    assert(leaving.status === 400 && /[Hh]and the lead over/.test(leaving.body?.error ?? ''),
        'a lead leaving while others are here is refused with what to do about it');

    const hidden = createGroup({ name: 'Hidden Lead', joinPolicy: 'invite_only', createdBy: ra });
    assert((await dispatch(router, 'POST', `/api/groups/${hidden.id}/lead`, outsider, { targetPubkey: outsider })).status === 404,
        'the hand-over route keeps an invite-only group hidden from outsiders');

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exit(1);
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
