/**
 * Groups redesign slice 1 — convenor succession (answer B, decision 17, 2026-09-19), mirroring enterprise
 * succession (#920) where it fits.
 *
 *  1. Only a group whose ONLY convenor has shown no node activity for 30 days can choose a new one.
 *  2. Any active member (role member) may propose a member — themselves included. Observers, outsiders,
 *     removed members and the convenor cannot; the candidate cannot be an observer or the convenor.
 *  3. One open vote per group. The proposal is the proposer's yes; a vote cannot be changed.
 *  4. Passing: more than half of those who answer say yes. It closes early the moment the result cannot change,
 *     otherwise at the 14-day deadline (yes must outnumber no). Passing makes the candidate convenor and the old
 *     convenor a member.
 *  5. The convenor coming back — any signed activity — cancels it. So does the candidate leaving, or the group
 *     getting another convenor.
 *  6. Ballots are secret: totals and your own vote, never who voted how.
 *  7. Every step writes a line in the group's chat.
 *  8. The routes: member-only, statuses, invite-only hidden from outsiders.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { db } from './db/db.js';
import {
    initStateEngine, createGroup, joinGroup, removeGroupMember, setMemberRole, inviteGroupMember,
    proposeGroupConvenor, voteGroupConvenor, getGroupSuccession, tickGroupSuccession, recordActivity,
    GROUP_SUCCESSION_WINDOW_MS, GroupSystemType,
} from './state-engine.js';
import { createGroupRoutes } from './routes/groups.js';
import { proposeGroupConvenor as proposeWithCb } from './engine/group-succession.js';
import { setChatMute } from './engine/chat-mutes.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
}
function assertThrows(fn: () => unknown, match: RegExp, msg: string): void {
    run++;
    try {
        fn();
        console.error(`✗ FAIL: ${msg} (nothing thrown)`);
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
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pub, callsign, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pub);
    return pub;
}
/** Make a member look silent: no activity (and no joining) for `days` days. */
function silence(pub: string, days = 31): void {
    const then = new Date(Date.now() - days * DAY).toISOString();
    db.prepare('UPDATE members SET last_active_at = ?, joined_at = ? WHERE public_key = ?').run(then, then, pub);
}
const role = (g: string, pk: string) => (db.prepare('SELECT role FROM group_members WHERE group_id = ? AND member_pubkey = ?').get(g, pk) as any)?.role;
const prop = (id: string) => db.prepare('SELECT * FROM group_convenor_proposals WHERE id = ?').get(id) as any;
const lastLine = (g: string) => db.prepare("SELECT system_type, ciphertext FROM messages WHERE conversation_id = ? AND type = 'system' ORDER BY rowid DESC LIMIT 1").get(g) as any;

/** A group with an open join policy: convenor plus the given members. */
function groupOf(name: string, convenor: string, members: string[]): string {
    const g = createGroup({ name, joinPolicy: 'open', createdBy: convenor });
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
    const ctx: any = { params, requestBody: body ?? {}, state: actor ? { actor } : {}, query: {}, get: () => '', set: () => { }, headers: {} };
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

    // ── 1–3. Who may propose, and when ──────────────────────────────────────────────────────
    console.log('\n--- 1–3. Eligibility, proposer and candidate ---');
    const alice = makeMember('Alice');   // the convenor who goes quiet
    const bob = makeMember('Bob');
    const carol = makeMember('Carol');
    const dave = makeMember('Dave');
    const olive = makeMember('Olive');   // observer
    const erin = makeMember('Erin');     // outsider
    const g1 = groupOf('Tool Library', alice, [bob, carol, dave, olive]);
    setMemberRole(g1, alice, olive, 'observer');

    assertThrows(() => proposeGroupConvenor(g1, bob, carol), /active on the node within the last 30 days/,
        'an active convenor cannot be replaced');
    silence(alice, 29);
    assertThrows(() => proposeGroupConvenor(g1, bob, carol), /30 days/, 'nor one silent for 29 days');
    silence(alice, 31);
    assert(getGroupSuccession(g1, bob).silence.isEligible === true && getGroupSuccession(g1, bob).canPropose === true,
        'after 30 days of silence a member may propose');
    assert(getGroupSuccession(g1, olive).canPropose === false, 'an observer may not');
    assertThrows(() => proposeGroupConvenor(g1, olive, bob), /Only an active member/, 'an observer cannot propose');
    assertThrows(() => proposeGroupConvenor(g1, erin, bob), /Only an active member/, 'an outsider cannot propose');
    assertThrows(() => proposeGroupConvenor(g1, bob, olive), /candidate must be an active member/, 'an observer cannot be the candidate');
    assertThrows(() => proposeGroupConvenor(g1, bob, alice), /cannot be the current convenor/, 'nor the convenor');
    assertThrows(() => proposeGroupConvenor(g1, bob, erin), /candidate must be an active member/, 'nor an outsider');

    const opened = proposeGroupConvenor(g1, bob, carol);
    assert(opened.executed === false && opened.proposal.status === 'active', 'Bob proposes Carol: the vote opens');
    assert(opened.proposal.yesCount === 1 && opened.proposal.electorateSize === 3, "the proposal is Bob's yes; 3 members may vote");
    const deadline = Date.parse(opened.proposal.deadlineAt) - Date.parse(opened.proposal.createdAt);
    assert(Math.abs(deadline - GROUP_SUCCESSION_WINDOW_MS) < 1000 && GROUP_SUCCESSION_WINDOW_MS === 14 * DAY, 'it runs 14 days — never open-ended');
    const openLine = lastLine(g1);
    assert(openLine?.system_type === GroupSystemType.CONVENOR_VOTE_OPENED && /Bob proposed Carol as lead convenor/.test(openLine.ciphertext),
        'the chat says who proposed whom, and why');
    assertThrows(() => proposeGroupConvenor(g1, dave, dave), /already open/, 'one open vote per group');
    assertThrows(() => voteGroupConvenor(opened.proposal.id, bob, 'no'), /already voted/, 'the proposer cannot vote again (a vote cannot be changed)');
    assertThrows(() => voteGroupConvenor(opened.proposal.id, olive, 'yes'), /Only an active member/, 'an observer cannot vote');
    assertThrows(() => voteGroupConvenor(opened.proposal.id, erin, 'yes'), /Only an active member/, 'an outsider cannot vote');
    assertThrows(() => voteGroupConvenor(opened.proposal.id, alice, 'no'), /Only an active member/, 'the silent convenor has no vote on their own replacement');

    // ── 6. Secret ballot ────────────────────────────────────────────────────────────────────
    const seenByDave = getGroupSuccession(g1, dave).proposals[0];
    assert(seenByDave.myVote === null && seenByDave.canVote === true, 'Dave sees he has not voted and may');
    assert(!('votes' in (seenByDave as any)) && !JSON.stringify(seenByDave).includes(`"voterPubkey"`), 'nobody is shown who voted how');
    assert(getGroupSuccession(g1, bob).proposals[0].myVote === 'yes', 'Bob sees his own vote');

    // ── 4. Early pass ───────────────────────────────────────────────────────────────────────
    console.log('\n--- 4. Passing ---');
    const passed1 = voteGroupConvenor(opened.proposal.id, carol, 'yes');
    assert(passed1.executed === true && passed1.proposal.status === 'passed', '2 of 3 say yes: settled early, it passes');
    assert(role(g1, carol) === 'convenor', 'Carol is convenor');
    assert(role(g1, alice) === 'member', 'Alice is an ordinary member now, still in the group');
    assert(lastLine(g1)?.system_type === GroupSystemType.CONVENOR_CHOSEN && /Members chose Carol as lead convenor \(2 yes, 0 no\)/.test(lastLine(g1).ciphertext),
        'the chat says the members chose Carol');
    assertThrows(() => voteGroupConvenor(opened.proposal.id, dave, 'yes'), /closed/, 'a closed vote takes no more votes');

    // Early rejection.
    const k = makeMember('Kim'); const l = makeMember('Lee'); const m = makeMember('Max'); const n = makeMember('Nia');
    const g2 = groupOf('Choir', k, [l, m, n]);
    silence(k);
    const p2 = proposeGroupConvenor(g2, l, l);
    assert(/Lee offered to be lead convenor/.test(lastLine(g2).ciphertext), 'proposing yourself reads as offering');
    voteGroupConvenor(p2.proposal.id, m, 'no');
    const r2 = voteGroupConvenor(p2.proposal.id, n, 'no');
    assert(r2.proposal.status === 'cancelled' && r2.proposal.closedReason === 'rejected', '1 yes, 2 no: rejected');
    assert(role(g2, k) === 'convenor' && role(g2, l) === 'member', 'nothing changes');
    assert(/not enough members said yes/.test(lastLine(g2).ciphertext), 'the chat says why it closed');

    // ── 4. The deadline ─────────────────────────────────────────────────────────────────────
    console.log('\n--- 4. The 14-day deadline ---');
    const q = makeMember('Quinn'); const r = makeMember('Ros'); const s = makeMember('Sam'); const t = makeMember('Tai');
    const g3 = groupOf('Repair Cafe', q, [r, s, t]);
    silence(q);
    const p3 = proposeGroupConvenor(g3, r, s);
    assert(tickGroupSuccession(Date.now() + GROUP_SUCCESSION_WINDOW_MS - DAY).passed === 0 && prop(p3.proposal.id).status === 'active',
        'before the deadline the tick leaves it open');
    tickGroupSuccession(Date.now() + GROUP_SUCCESSION_WINDOW_MS + 1000);
    assert(prop(p3.proposal.id).status === 'passed' && role(g3, s) === 'convenor',
        'at the deadline, 1 yes and nobody else answering: more than half of those who answered said yes — it passes');

    const u = makeMember('Uma'); const v = makeMember('Vic'); const w = makeMember('Wes'); const x = makeMember('Xan');
    const g4 = groupOf('Walkers', u, [v, w, x]);
    silence(u);
    const p4 = proposeGroupConvenor(g4, v, v);
    voteGroupConvenor(p4.proposal.id, w, 'no');
    assert(prop(p4.proposal.id).status === 'active', '1 yes, 1 no, one still to answer: still open');
    tickGroupSuccession(Date.now() + GROUP_SUCCESSION_WINDOW_MS + 1000);
    assert(prop(p4.proposal.id).status === 'cancelled' && prop(p4.proposal.id).closed_reason === 'rejected' && role(g4, u) === 'convenor',
        'at the deadline a tie is not more than half: rejected');

    // ── 5. Cancellation ─────────────────────────────────────────────────────────────────────
    console.log('\n--- 5. The convenor comes back; the candidate leaves ---');
    const y = makeMember('Yan'); const z = makeMember('Zoe'); const a2 = makeMember('Ari'); const b2 = makeMember('Bea');
    const g5 = groupOf('Knitters', y, [z, a2, b2]);
    silence(y);
    const p5 = proposeGroupConvenor(g5, z, a2);
    recordActivity(y); // any signed write
    assert(prop(p5.proposal.id).status === 'cancelled' && prop(p5.proposal.id).closed_reason === 'convenor_returned',
        'the convenor doing anything on the node cancels the vote at once');
    assert(/the convenor is back/.test(lastLine(g5).ciphertext), 'and the chat says so');
    assertThrows(() => voteGroupConvenor(p5.proposal.id, b2, 'yes'), /closed/, 'no more votes after that');
    assertThrows(() => proposeGroupConvenor(g5, z, a2), /30 days/, 'and a new proposal waits another 30 days');

    silence(y);
    const p6 = proposeGroupConvenor(g5, z, a2);
    // Activity written some other way than recordActivity is caught on the next touch.
    db.prepare('UPDATE members SET last_active_at = ? WHERE public_key = ?').run(new Date(Date.now() + 1000).toISOString(), y);
    assertThrows(() => voteGroupConvenor(p6.proposal.id, b2, 'yes'), /closed/, 'a vote after the convenor returned is refused');
    assert(prop(p6.proposal.id).closed_reason === 'convenor_returned', 'and the proposal records why');

    const c3 = makeMember('Cai'); const d3 = makeMember('Dot'); const e3 = makeMember('Eve'); const f3 = makeMember('Fin');
    const g6 = groupOf('Bee Keepers', c3, [d3, e3, f3]);
    silence(c3);
    const p7 = proposeGroupConvenor(g6, d3, e3);
    removeGroupMember(g6, e3, e3); // the candidate leaves
    assertThrows(() => voteGroupConvenor(p7.proposal.id, f3, 'yes'), /closed/, 'the candidate leaving closes the vote');
    assert(prop(p7.proposal.id).closed_reason === 'candidate_gone', 'recorded as candidate_gone');

    // A group with a second convenor used to have "nobody to replace": the vote only ever covered a SOLE
    // convenor. Since the lead convenor (2026-09-23) the subject is the LEAD, so a silent lead with other
    // convenors under them is reachable — and it is those convenors who vote, not the members. Without this a
    // silent lead could never be replaced at all, because nobody may remove or demote a lead.
    const g7 = groupOf('Two Convenors', c3, [d3, e3]);
    setMemberRole(g7, c3, d3, 'convenor');
    silence(c3);
    const view7 = getGroupSuccession(g7, d3);
    assert(view7.silence.convenorPubkey === c3 && view7.silence.electorate === 'convenors' && view7.silence.isEligible === true,
        'a silent lead with another convenor CAN be replaced, by that convenor');
    assert(getGroupSuccession(g7, e3).canPropose === false, 'an ordinary member has no say while a convenor does');
    assertThrows(() => proposeGroupConvenor(g7, e3, e3), /Only an active convenor/, 'and cannot open the vote');
    const p9 = proposeGroupConvenor(g7, d3, d3);
    assert(p9.executed === true && role(g7, d3) === 'convenor' && role(g7, c3) === 'convenor',
        'the only other convenor offering themselves settles it at once, and the old lead stays a convenor');

    // A voter who leaves loses their say.
    const h = makeMember('Hal'); const i = makeMember('Ivy'); const j = makeMember('Jo'); const k2 = makeMember('Kit'); const l2 = makeMember('Lou');
    const g8 = groupOf('Cyclists', h, [i, j, k2, l2]);
    silence(h);
    const p8 = proposeGroupConvenor(g8, i, i);
    voteGroupConvenor(p8.proposal.id, j, 'yes');
    removeGroupMember(g8, j, j);
    assert(getGroupSuccession(g8, i).proposals[0].yesCount === 1, 'a member who voted and then left no longer counts');

    // ── 8. The routes ───────────────────────────────────────────────────────────────────────
    console.log('\n--- 8. HTTP ---');
    const ga = makeMember('Gus'); const gb = makeMember('Gia'); const gc = makeMember('Gil'); const out = makeMember('Out');
    const g9 = groupOf('Pottery', ga, [gb, gc]);
    silence(ga);
    const view = await dispatch(router, 'GET', `/api/groups/${g9}/succession`, gb);
    assert(view.status === undefined && view.body.canPropose === true && view.body.silence.convenorPubkey === ga, 'a member reads the succession state');
    assert(/T00:00:00\.000Z$/.test(view.body.silence.lastActiveAt) && Number.isInteger(view.body.silence.daysInactive),
        "the convenor's last activity is served to the day, in whole days (no timing a vote to its voter, #923)");
    const own = await dispatch(router, 'GET', `/api/groups/${g9}/succession`, ga);
    assert(own.body.silence.lastActiveAt === (db.prepare('SELECT last_active_at FROM members WHERE public_key = ?').get(ga) as any).last_active_at,
        'the convenor sees their own exact time');
    assert((await dispatch(router, 'GET', `/api/groups/${g9}/succession`, out)).status === 403, 'an outsider is refused');
    assert((await dispatch(router, 'GET', `/api/groups/${g9}/succession`, undefined)).status === 401, 'unsigned: 401');
    assert((await dispatch(router, 'POST', `/api/groups/${g9}/succession/propose`, gb, {})).status === 400, 'a proposal needs a candidate');
    const viaHttp = await dispatch(router, 'POST', `/api/groups/${g9}/succession/propose`, gb, { candidatePubkey: gc });
    assert(viaHttp.body?.success === true && viaHttp.body.proposal.status === 'active', 'a member proposes over HTTP');
    const again = await dispatch(router, 'POST', `/api/groups/${g9}/succession/propose`, gc, { candidatePubkey: gc });
    assert(again.status === 409, 'a second open vote is 409');
    const pid = viaHttp.body.proposal.id;
    assert((await dispatch(router, 'POST', `/api/groups/${g9}/succession/${pid}/vote`, gc, { choice: 'maybe' })).status === 400, 'only yes or no');
    assert((await dispatch(router, 'POST', `/api/groups/${g1}/succession/${pid}/vote`, bob, { choice: 'yes' })).status === 404,
        'a proposal addressed through another group is not found');
    assert((await dispatch(router, 'POST', `/api/groups/${g9}/succession/${pid}/vote`, out, { choice: 'yes' })).status === 403, 'an outsider cannot vote');
    const voted = await dispatch(router, 'POST', `/api/groups/${g9}/succession/${pid}/vote`, gc, { choice: 'yes' });
    assert(voted.body?.executed === true && role(g9, gc) === 'convenor', 'the second yes passes it over HTTP');
    assert((await dispatch(router, 'POST', `/api/groups/${g9}/succession/${pid}/vote`, gb, { choice: 'yes' })).status === 409, 'voting on a closed vote is 409');

    const hidden = createGroup({ name: 'Private', joinPolicy: 'invite_only', createdBy: ga });
    inviteGroupMember(hidden.id, ga, gb);
    assert((await dispatch(router, 'GET', `/api/groups/${hidden.id}/succession`, out)).status === 404, 'an invite-only group is 404 to an outsider');
    assert((await dispatch(router, 'POST', `/api/groups/${hidden.id}/succession/propose`, out, { candidatePubkey: out })).status === 404, 'for writes too');

    // ── 9. The sitting convenor is told once (PR #924 review, item 3) ───────────────────────
    console.log('\n--- 9. A push to the convenor when a vote to replace them opens ---');
    const pushes: { targets: string[]; actor: string; title: string; body: string; data: any; category: string }[] = [];
    const cb = {
        broadcast: () => { },
        dispatchPushNotification: (targets: string[], actor: string, title: string, body: string, data: any, category: string) => {
            pushes.push({ targets, actor, title, body, data, category });
        },
    };
    const pa = makeMember('Pia'); const pb = makeMember('Pat'); const pc = makeMember('Pen'); const pd = makeMember('Pip');
    const g10 = groupOf('Seed Swap', pa, [pb, pc, pd]);
    silence(pa);
    setChatMute(g10, pa, 'always'); // a muted group chat does not hide a vote on the convenor's own role
    const p10 = proposeWithCb(cb as any, g10, pb, pc);
    const toConvenor = pushes.filter(x => x.targets.includes(pa));
    assert(p10.proposal.status === 'active' && toConvenor.length === 1, `the silent convenor gets exactly one push (got ${toConvenor.length})`);
    assert(pushes.length === 1 && toConvenor[0]?.targets.length === 1, 'and nobody else is pushed for the vote opening');
    assert(toConvenor[0]?.category === 'chat' && toConvenor[0]?.actor === pb, 'through the normal chat push path, from the proposer');
    assert(toConvenor[0]?.data?.groupId === g10 && toConvenor[0]?.data?.screen === 'chat', 'it opens the group');
    assert(/convenor/i.test(toConvenor[0]?.body ?? ''), 'and says what it is about');
    voteGroupConvenor(p10.proposal.id, pd, 'no');
    assert(pushes.filter(x => x.targets.includes(pa)).length === 1, 'a vote being cast pushes nobody');

    // ── 10. A lost race for the one open vote is a clean 409 (PR #924 review, item 7) ──────
    console.log('\n--- 10. Two proposals at once ---');
    const ra = makeMember('Rae'); const rb = makeMember('Rex'); const rc = makeMember('Rio');
    const g11 = groupOf('Book Club', ra, [rb, rc]);
    silence(ra);
    // Stand in for the other request that won: its proposal lands between our check and our insert.
    db.exec(`CREATE TEMP TRIGGER race_winner BEFORE INSERT ON group_convenor_proposals
             WHEN NEW.id != 'race-winner' AND NEW.group_id = '${g11}'
             BEGIN
               INSERT INTO group_convenor_proposals (id, group_id, convenor_pubkey, candidate_pubkey, proposer_pubkey, status, created_at, deadline_at)
               VALUES ('race-winner', NEW.group_id, NEW.convenor_pubkey, NEW.proposer_pubkey, NEW.proposer_pubkey, 'active', NEW.created_at, NEW.deadline_at);
             END`);
    const lost = await dispatch(router, 'POST', `/api/groups/${g11}/succession/propose`, rb, { candidatePubkey: rc });
    db.exec('DROP TRIGGER race_winner');
    assert(lost.status === 409, `the loser gets 409 (got ${lost.status})`);
    assert(!/UNIQUE|constraint|SQLITE/i.test(lost.body?.error ?? '') && /already open/.test(lost.body?.error ?? ''),
        `with a human message, not the database's (got "${lost.body?.error}")`);

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exit(1);
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
