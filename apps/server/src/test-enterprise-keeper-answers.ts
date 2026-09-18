/**
 * Enterprise keeper answers (board, 2026-09-19): A, G and M.
 *
 * A — Adding a keeper: the lead approves, then any other keeper can object within 3 days, which cancels it. A
 *     one-keeper enterprise adds at once. The pledge is re-checked when the window ends.
 * G — Lead removed by the community: the longest-serving remaining active keeper becomes lead at once, and the
 *     other keepers may run succession immediately (no 30-day wait). No other keeper: the enterprise pauses.
 * M — Housekeeping: succession has a 14-day deadline and a No vote (passes on more than half of the other keepers
 *     saying yes); the lead can remove an ordinary keeper with the same 3-day objection window as A; any keeper
 *     can step down, unless their pledge is still needed to cover the enterprise's debt.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-enterprise-keeper-answers.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import {
    initStateEngine, createTreasury, getBalance, adminAssignTreasuryOperator, adminSetOperator,
    requestToJoinEnterprise, approveKeeperRequest, getKeeperRequests, getKeeperChanges,
    objectToKeeperChange, proposeKeeperRemoval, stepDownAsKeeper, pledgeEnterpriseBacking,
    getLeadInactivity, proposeLeadSuccession, voteLeadSuccession, getSuccessionProposals,
    tickEnterpriseKeepers, KEEPER_CHANGE_OBJECTION_MS, SUCCESSION_WINDOW_MS, getAvailableBacking,
} from './state-engine.js';
import { createDecision, executeDecision, getDecision } from './decisions-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { ledger } from './engine/ledger.js';

const PORT = 8671;
const BASE = `https://localhost:${PORT}`;
const AFTER_WINDOW = () => Date.now() + KEEPER_CHANGE_OBJECTION_MS + 1000;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else {
        console.error(`✗ ${msg}`);
        throw new Error(`Assertion failed: ${msg}`);
    }
}

function expectThrow(fn: () => unknown, fragment: string, msg: string): void {
    let message = '';
    let threw = false;
    try { fn(); } catch (e: any) { threw = true; message = e?.message || String(e); }
    assert(threw && message.includes(fragment), `${msg}${threw ? (message.includes(fragment) ? '' : ` (threw: ${message})`) : ' (did not throw)'}`);
}

function giveEarnedCredit(pubkey: string, targetEarned: number) {
    let vNeeded = Math.ceil((5000 * targetEarned) / (1920 - targetEarned));
    let peerIndex = 0;
    while (vNeeded > 0) {
        const tradeAmount = Math.min(vNeeded, 400);
        const peerKey = `peer-${pubkey.slice(0, 8)}-${peerIndex++}`;
        db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, avatar_url, joined_at, status) VALUES (?, ?, 'avatar', ?, 'active')`).run(peerKey, `Peer${peerIndex}`, new Date().toISOString());
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 1000, 0)`).run(peerKey);
        const pid = `post-ec-${crypto.randomUUID()}`;
        db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status) VALUES (?, 'offer', 'misc', 'goods', 'description', ?, ?, 'completed')`).run(pid, tradeAmount, peerKey);
        db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status) VALUES (?, ?, ?, ?, ?, 'completed')`).run(`mtx-ec-${crypto.randomUUID()}`, pid, pubkey, peerKey, tradeAmount);
        vNeeded -= tradeAmount;
    }
}

let seq = 0;
function makeIdentity(callsign: string, earnedCredit = 0) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const now = new Date().toISOString();
    db.prepare(`
        INSERT OR REPLACE INTO members (public_key, callsign, avatar_url, joined_at, status, can_operate, last_active_at)
        VALUES (?, ?, 'data:image/png;base64,iVBORw0KGgo=', ?, 'active', 1, ?)
    `).run(pubKeyHex, `${callsign}${++seq}`, now, now);
    db.prepare(`INSERT OR REPLACE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 1000, 0)`).run(pubKeyHex);
    if (earnedCredit > 0) giveEarnedCredit(pubKeyHex, earnedCredit);
    return { pubKeyHex, privateKey };
}

type Id = ReturnType<typeof makeIdentity>;

/** An enterprise with a lead and ordinary keepers, bound in order with increasing granted_at (seniority). */
function makeEnterprise(name: string, lead: Id, others: Id[]): string {
    const { publicKey: ent } = createTreasury(`${name}${++seq}`, 'avatar', 0);
    const all = [lead, ...others];
    all.forEach((k, i) => {
        adminAssignTreasuryOperator(ent, k.pubKeyHex, 'admin', 0);
        db.prepare("UPDATE treasury_operators SET granted_at = ? WHERE treasury_pubkey = ? AND member_pubkey = ?")
            .run(new Date(Date.now() - (100 - i) * 86400000).toISOString(), ent, k.pubKeyHex);
    });
    db.prepare("UPDATE treasury_operators SET role = 'lead' WHERE treasury_pubkey = ? AND member_pubkey = ?").run(ent, lead.pubKeyHex);
    return ent;
}

function role(ent: string, member: string): string | null {
    return (db.prepare("SELECT role FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?").get(ent, member) as any)?.role ?? null;
}

function activePledge(ent: string, keeper: string): number {
    return Number((db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM enterprise_pledges WHERE enterprise = ? AND keeper = ? AND released_at IS NULL").get(ent, keeper) as any).t);
}

/** Set the enterprise's balance directly, in the ledger and its row (a test fixture, not a ledger path). */
function setEnterpriseBalance(ent: string, balance: number) {
    ledger.getAccount(ent).balance = balance;
    db.prepare("INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, 0) ON CONFLICT(public_key) DO UPDATE SET balance = excluded.balance").run(ent, balance);
}

async function signedFetch(method: 'GET' | 'POST', path: string, id: Id, body?: any) {
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${path}\n${ts}\n${nonce}\n${bodyString}`;
    const headers: Record<string, string> = {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'POST' ? bodyString : undefined });
    let json: any; try { json = await res.json(); } catch { /* */ }
    return { status: res.status, error: json?.error as string | undefined, body: json };
}

async function main() {
    await initTls();
    initStateEngine();
    const admin = makeIdentity('Admin', 50);
    db.prepare("INSERT OR REPLACE INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'admin', 'system')").run(admin.pubKeyHex);

    // =====================================================================
    console.log('\n── A: adding a keeper — lead approves, other keepers may object for 3 days ──');
    {
        const lead = makeIdentity('ALead', 40), k2 = makeIdentity('AK2', 40), k3 = makeIdentity('AK3', 40);
        const ent = makeEnterprise('AEnt', lead, [k2, k3]);

        // Objected: one objection cancels.
        const app1 = makeIdentity('AApp1', 30);
        const r1 = requestToJoinEnterprise(ent, app1.pubKeyHex, 10);
        const res1 = approveKeeperRequest(r1.id, lead.pubKeyHex);
        assert(res1.applied === false && !!res1.change, 'A: approval with other keepers opens a pending change');
        assert(role(ent, app1.pubKeyHex) === null, 'A: applicant is not a keeper during the window');
        const appliesIn = new Date(res1.change!.appliesAt).getTime() - Date.now();
        assert(Math.abs(appliesIn - KEEPER_CHANGE_OBJECTION_MS) < 60_000, 'A: the window is 3 days');
        const listed = getKeeperRequests(ent, 'pending').find(r => r.id === r1.id);
        assert(listed?.pendingChange?.id === res1.change!.id, 'A: the pending request carries its pending change');
        expectThrow(() => approveKeeperRequest(r1.id, lead.pubKeyHex), 'waiting out its objection window', 'A: cannot approve twice');
        expectThrow(() => objectToKeeperChange(res1.change!.id, lead.pubKeyHex), 'cannot object', 'A: the lead cannot object to their own change');
        const stranger = makeIdentity('AStranger');
        expectThrow(() => objectToKeeperChange(res1.change!.id, stranger.pubKeyHex), 'Only an active keeper', 'A: a non-keeper cannot object');
        const obj = objectToKeeperChange(res1.change!.id, k2.pubKeyHex);
        assert(obj.change.status === 'objected' && obj.change.resolvedBy === k2.pubKeyHex, 'A: another keeper objects, which cancels it');
        tickEnterpriseKeepers(AFTER_WINDOW());
        assert(role(ent, app1.pubKeyHex) === null, 'A: objected applicant never becomes a keeper');
        assert((db.prepare("SELECT status FROM enterprise_keeper_requests WHERE id = ?").get(r1.id) as any).status === 'declined',
            'A: the objected request is declined');

        // Unopposed: applies when the window ends, not before.
        const app2 = makeIdentity('AApp2', 30);
        const r2 = requestToJoinEnterprise(ent, app2.pubKeyHex, 20);
        const res2 = approveKeeperRequest(r2.id, lead.pubKeyHex);
        tickEnterpriseKeepers(Date.now() + KEEPER_CHANGE_OBJECTION_MS - 60_000);
        assert(role(ent, app2.pubKeyHex) === null, 'A: not applied before the window ends');
        tickEnterpriseKeepers(AFTER_WINDOW());
        assert(role(ent, app2.pubKeyHex) === 'keeper', 'A: applied when the window ends');
        assert(activePledge(ent, app2.pubKeyHex) === 20, 'A: the pledge is recorded at apply');
        assert(getKeeperChanges(ent).find(c => c.id === res2.change!.id)?.status === 'applied', 'A: the change reads applied');
        expectThrow(() => objectToKeeperChange(res2.change!.id, k3.pubKeyHex), 'window for this change has closed', 'A: no objection after the window');

        // Pledge re-checked at apply time.
        const app3 = makeIdentity('AApp3', 30);
        const r3 = requestToJoinEnterprise(ent, app3.pubKeyHex, 30);
        const res3 = approveKeeperRequest(r3.id, lead.pubKeyHex);
        const { publicKey: elsewhere } = createTreasury(`AElsewhere${++seq}`, 'avatar', 0);
        db.prepare("INSERT INTO enterprise_pledges (id, keeper, enterprise, amount, pledged_at, released_at) VALUES (?, ?, ?, 20, ?, NULL)")
            .run(crypto.randomUUID(), app3.pubKeyHex, elsewhere, new Date().toISOString());
        assert(getAvailableBacking(app3.pubKeyHex) === 10, 'A: applicant pledged elsewhere during the window (10 left)');
        tickEnterpriseKeepers(AFTER_WINDOW());
        const c3 = getKeeperChanges(ent).find(c => c.id === res3.change!.id)!;
        assert(c3.status === 'failed' && /exceeds available earned credit/.test(c3.reason || ''), 'A: an over-pledge at apply time fails the change');
        assert(role(ent, app3.pubKeyHex) === null && activePledge(ent, app3.pubKeyHex) === 0, 'A: no binding and no pledge after a failed apply');

        // The lead who approved it is no longer lead when the window ends.
        const app4 = makeIdentity('AApp4', 10);
        const r4 = requestToJoinEnterprise(ent, app4.pubKeyHex, 0);
        const res4 = approveKeeperRequest(r4.id, lead.pubKeyHex);
        db.prepare("UPDATE treasury_operators SET role = 'keeper' WHERE treasury_pubkey = ? AND member_pubkey = ?").run(ent, lead.pubKeyHex);
        db.prepare("UPDATE treasury_operators SET role = 'lead' WHERE treasury_pubkey = ? AND member_pubkey = ?").run(ent, k2.pubKeyHex);
        tickEnterpriseKeepers(AFTER_WINDOW());
        assert(getKeeperChanges(ent).find(c => c.id === res4.change!.id)?.status === 'failed' && role(ent, app4.pubKeyHex) === null,
            'A: a change whose lead has since lost the role does not apply');

        // One keeper: at once.
        const solo = makeIdentity('ASolo', 10);
        const { publicKey: soloEnt } = createTreasury(`ASoloEnt${++seq}`, 'avatar', 0);
        adminAssignTreasuryOperator(soloEnt, solo.pubKeyHex, 'admin', 0);
        const app5 = makeIdentity('AApp5', 10);
        const res5 = approveKeeperRequest(requestToJoinEnterprise(soloEnt, app5.pubKeyHex, 0).id, solo.pubKeyHex);
        assert(res5.applied === true && role(soloEnt, app5.pubKeyHex) === 'keeper', 'A: a one-keeper enterprise adds at once');
    }

    // =====================================================================
    console.log('\n── M: the lead removes an ordinary keeper, with the same objection window ──');
    {
        const lead = makeIdentity('RLead', 40), k2 = makeIdentity('RK2', 40), k3 = makeIdentity('RK3', 40), k4 = makeIdentity('RK4', 40);
        const ent = makeEnterprise('REnt', lead, [k2, k3, k4]);
        pledgeEnterpriseBacking(ent, k3.pubKeyHex, 15);

        expectThrow(() => proposeKeeperRemoval(ent, k2.pubKeyHex, k3.pubKeyHex), 'Only the lead keeper', 'M: an ordinary keeper cannot remove a keeper');
        expectThrow(() => proposeKeeperRemoval(ent, lead.pubKeyHex, lead.pubKeyHex), 'step down', 'M: the lead removing themselves is pointed to step down');

        const rm = proposeKeeperRemoval(ent, lead.pubKeyHex, k3.pubKeyHex);
        assert(rm.applied === false && rm.change?.kind === 'remove', 'M: removal opens a pending change');
        assert(role(ent, k3.pubKeyHex) === 'keeper', 'M: still a keeper during the window');
        expectThrow(() => objectToKeeperChange(rm.change!.id, k3.pubKeyHex), 'your own removal', 'M: the keeper being removed cannot object');
        expectThrow(() => proposeKeeperRemoval(ent, lead.pubKeyHex, k3.pubKeyHex), 'already waiting', 'M: one pending change per keeper');
        tickEnterpriseKeepers(AFTER_WINDOW());
        assert(role(ent, k3.pubKeyHex) === null, 'M: removed when the window ends');
        assert(activePledge(ent, k3.pubKeyHex) === 0, 'M: a solvent enterprise releases the removed keeper\'s pledge');

        const rm2 = proposeKeeperRemoval(ent, lead.pubKeyHex, k4.pubKeyHex);
        objectToKeeperChange(rm2.change!.id, k2.pubKeyHex);
        tickEnterpriseKeepers(AFTER_WINDOW());
        assert(role(ent, k4.pubKeyHex) === 'keeper', 'M: an objected removal leaves the keeper in place');

        // The lead cannot be removed this way.
        const ent2 = makeEnterprise('REnt2', k2, [lead]);
        expectThrow(() => proposeKeeperRemoval(ent2, admin.pubKeyHex, k2.pubKeyHex), 'lead keeper cannot be removed this way', 'M: the lead is not removable as a keeper');
    }

    // =====================================================================
    console.log('\n── M: any keeper can step down; not while their pledge covers the debt ──');
    {
        const lead = makeIdentity('SLead', 60), k2 = makeIdentity('SK2', 60), k3 = makeIdentity('SK3', 60);
        const ent = makeEnterprise('SEnt', lead, [k2, k3]);
        pledgeEnterpriseBacking(ent, k2.pubKeyHex, 40);
        pledgeEnterpriseBacking(ent, k3.pubKeyHex, 10);

        // In debt by 30: the others' pledges (10) do not cover it without k2's 40.
        setEnterpriseBalance(ent, -30);
        assert(getBalance(ent).balance === -30, 'M: fixture — the enterprise is 30 beans in debt');
        expectThrow(() => stepDownAsKeeper(ent, k2.pubKeyHex), '30 beans in debt', 'M: a keeper whose pledge covers the debt cannot step down yet');
        expectThrow(() => stepDownAsKeeper(ent, k2.pubKeyHex), 'other keepers pledge 20 beans more', 'M: the refusal says what must happen first');
        assert(role(ent, k2.pubKeyHex) === 'keeper' && activePledge(ent, k2.pubKeyHex) === 40, 'M: refused step-down changes nothing');

        // k3's pledge is not needed (k2's 40 covers 30): k3 may go, and their pledge is released.
        const sd = stepDownAsKeeper(ent, k3.pubKeyHex);
        assert(sd.ok && role(ent, k3.pubKeyHex) === null && activePledge(ent, k3.pubKeyHex) === 0, 'M: a keeper whose pledge is not needed steps down and is released');

        setEnterpriseBalance(ent, 0);
        const sd2 = stepDownAsKeeper(ent, k2.pubKeyHex);
        assert(sd2.releasedBacking === 40 && activePledge(ent, k2.pubKeyHex) === 0, 'M: once solvent, the keeper steps down and the pledge is released');
        expectThrow(() => stepDownAsKeeper(ent, lead.pubKeyHex), 'only keeper', 'M: the only keeper cannot step down');
        expectThrow(() => stepDownAsKeeper(ent, k2.pubKeyHex), 'not a keeper', 'M: a non-keeper cannot step down');
    }

    // =====================================================================
    console.log('\n── G / M: a lead stepping down hands on by seniority ──');
    {
        const lead = makeIdentity('PLead'), senior = makeIdentity('PSenior'), junior = makeIdentity('PJunior');
        const ent = makeEnterprise('PEnt', lead, [senior, junior]);
        const r = stepDownAsKeeper(ent, lead.pubKeyHex);
        assert(r.promoted === senior.pubKeyHex && role(ent, senior.pubKeyHex) === 'lead', 'G: the longest-serving keeper becomes lead');
        assert(getLeadInactivity(ent).autoPromoted === true && getLeadInactivity(ent).isEligible === true,
            'G: succession is open at once after an automatic promotion');
        const prop = proposeLeadSuccession(ent, junior.pubKeyHex, junior.pubKeyHex);
        assert(prop.executed === true && role(ent, junior.pubKeyHex) === 'lead', 'G: the other keepers can choose someone else immediately');
        assert(getLeadInactivity(ent).autoPromoted === false, 'G: a lead chosen by succession is not auto-promoted');

        // Only a suspended keeper left: the enterprise pauses.
        const lead2 = makeIdentity('PLead2'), susp = makeIdentity('PSusp');
        const ent2 = makeEnterprise('PEnt2', lead2, [susp]);
        adminSetOperator(susp.pubKeyHex, false);
        const r2 = stepDownAsKeeper(ent2, lead2.pubKeyHex);
        assert(r2.promoted === null && r2.paused === true, 'G: no active keeper left — the enterprise pauses');
        assert((db.prepare("SELECT paused FROM members WHERE public_key = ?").get(ent2) as any).paused === 1, 'G: paused flag set');
    }

    // =====================================================================
    console.log('\n── G: the community removes a lead ──');
    {
        const lead = makeIdentity('GLead'), senior = makeIdentity('GSenior'), junior = makeIdentity('GJunior'), third = makeIdentity('GThird');
        const ent = makeEnterprise('GEnt', lead, [senior, junior, third]);
        // A change the rogue lead made is still pending.
        const app = makeIdentity('GApp', 10);
        const pend = approveKeeperRequest(requestToJoinEnterprise(ent, app.pubKeyHex, 0).id, lead.pubKeyHex);

        const dec = createDecision({
            authorPubkey: admin.pubKeyHex, title: 'Remove the lead', description: 'G', touches: 'member',
            effect: 'remove_lead_keeper', subject: lead.pubKeyHex, params: { enterprisePubkey: ent, leadPubkey: lead.pubKeyHex },
        });
        const ex = executeDecision(dec.id);
        assert(ex.success && getDecision(dec.id)!.status === 'executed', 'G: remove_lead_keeper executes');
        assert(role(ent, lead.pubKeyHex) === null, 'G: the old lead is gone');
        assert(role(ent, senior.pubKeyHex) === 'lead', 'G: the longest-serving remaining keeper is lead at once');
        assert(role(ent, junior.pubKeyHex) === 'keeper', 'G: a newer keeper is not promoted');
        assert(getKeeperChanges(ent).find(c => c.id === pend.change!.id)?.status === 'failed', 'G: the removed lead\'s pending change is closed');

        // The promoted lead is active on the node — succession still runs at once, and their activity cancels nothing.
        db.prepare("UPDATE members SET last_active_at = ? WHERE public_key = ?").run(new Date().toISOString(), senior.pubKeyHex);
        const p = proposeLeadSuccession(ent, junior.pubKeyHex, third.pubKeyHex);
        assert(p.executed === false && p.proposal.status === 'active', 'G: succession opens at once despite the new lead being active');
        db.prepare("UPDATE members SET last_active_at = ? WHERE public_key = ?").run(new Date(Date.now() + 5000).toISOString(), senior.pubKeyHex);
        assert(getSuccessionProposals(ent).proposals[0].status === 'active', 'G: the auto-promoted lead\'s activity does not cancel it');
        const v = voteLeadSuccession(p.proposal.id, third.pubKeyHex, 'yes');
        assert(v.executed === true && role(ent, third.pubKeyHex) === 'lead', 'G: the keepers choose someone else');

        // No other keeper: pause.
        const lone = makeIdentity('GLone');
        const { publicKey: ent2 } = createTreasury(`GLoneEnt${++seq}`, 'avatar', 0);
        adminAssignTreasuryOperator(ent2, lone.pubKeyHex, 'admin', 0);
        db.prepare("UPDATE treasury_operators SET role = 'lead' WHERE treasury_pubkey = ?").run(ent2);
        const dec2 = createDecision({
            authorPubkey: admin.pubKeyHex, title: 'Remove the only lead', description: 'G', touches: 'member',
            effect: 'remove_lead_keeper', subject: lone.pubKeyHex, params: { enterprisePubkey: ent2, leadPubkey: lone.pubKeyHex },
        });
        assert(executeDecision(dec2.id).success, 'G: removing a lone lead executes');
        const m2 = db.prepare("SELECT paused, paused_by FROM members WHERE public_key = ?").get(ent2) as any;
        assert(m2.paused === 1 && m2.paused_by === `decision:${dec2.id}`, 'G: with no keeper left the enterprise pauses, attributed to the Decision');
    }

    // =====================================================================
    console.log('\n── M: succession has a 14-day deadline and a No vote ──');
    {
        const lead = makeIdentity('SuLead'), a = makeIdentity('SuA'), b = makeIdentity('SuB'), c = makeIdentity('SuC');
        const ent = makeEnterprise('SuEnt', lead, [a, b, c]);
        db.prepare("UPDATE members SET last_active_at = ? WHERE public_key = ?").run(new Date(Date.now() - 40 * 86400000).toISOString(), lead.pubKeyHex);

        const p = proposeLeadSuccession(ent, a.pubKeyHex, a.pubKeyHex);
        const span = new Date(p.proposal.deadlineAt).getTime() - new Date(p.proposal.createdAt).getTime();
        assert(span === SUCCESSION_WINDOW_MS, 'M: the proposal closes 14 days after it opens');
        assert(p.proposal.requiredVotes === 2 && p.proposal.votesCount === 1, 'M: 2 of 3 other keepers needed; the proposer counts as yes');
        const v1 = voteLeadSuccession(p.proposal.id, b.pubKeyHex, 'no');
        assert(v1.proposal.status === 'active' && v1.proposal.noVotesCount === 1, 'M: a No vote is recorded and the proposal stays open');
        assert(v1.proposal.votes.find(x => x.voterPubkey === b.pubKeyHex)?.choice === 'no', 'M: the vote reads as no');
        const v2 = voteLeadSuccession(p.proposal.id, c.pubKeyHex, 'no');
        assert(v2.executed === false && v2.proposal.status === 'cancelled' && v2.proposal.closedReason === 'rejected',
            'M: once a yes majority is out of reach, the proposal is rejected');
        assert(role(ent, lead.pubKeyHex) === 'lead', 'M: a rejected proposal leaves the lead in place');
        expectThrow(() => voteLeadSuccession(p.proposal.id, lead.pubKeyHex, 'yes'), 'no longer active', 'M: no voting on a closed proposal');

        const p2 = proposeLeadSuccession(ent, b.pubKeyHex, b.pubKeyHex);
        const t = tickEnterpriseKeepers(Date.now() + SUCCESSION_WINDOW_MS + 1000);
        assert(t.expired >= 1, 'M: the scheduler closes proposals past their deadline');
        const after = getSuccessionProposals(ent).proposals.find(x => x.id === p2.proposal.id)!;
        assert(after.status === 'cancelled' && after.closedReason === 'expired', 'M: an unpassed proposal expires');
        expectThrow(() => voteLeadSuccession(p2.proposal.id, c.pubKeyHex, 'yes'), '14-day deadline', 'M: a vote after the deadline is refused plainly');
        expectThrow(() => voteLeadSuccession('nope', c.pubKeyHex, 'maybe' as any), "'yes' or 'no'", 'M: only yes or no');
    }

    // =====================================================================
    console.log('\n── HTTP: the routes the apps call ──');
    startHttpsServer(PORT);
    await new Promise(r => setTimeout(r, 500));
    {
        const lead = makeIdentity('HLead', 20), k2 = makeIdentity('HK2', 20), k3 = makeIdentity('HK3', 20);
        const ent = makeEnterprise('HEnt', lead, [k2, k3]);

        const rm = await signedFetch('POST', `/api/enterprise/${ent}/keepers/${k3.pubKeyHex}/remove`, lead);
        assert(rm.status === 200 && rm.body?.applied === false && rm.body?.change?.kind === 'remove', 'HTTP: lead proposes a removal');
        const bad = await signedFetch('POST', `/api/enterprise/${ent}/keepers/${k2.pubKeyHex}/remove`, k3);
        assert(bad.status === 403, 'HTTP: an ordinary keeper is refused (403)');

        const detail = await signedFetch('GET', `/api/enterprise/${ent}`, k2);
        assert(Array.isArray(detail.body?.keeperChanges) && detail.body.keeperChanges.some((c: any) => c.id === rm.body.change.id),
            'HTTP: the enterprise detail lists pending keeper changes');

        const obj = await signedFetch('POST', `/api/enterprise/${ent}/keepers/changes/${rm.body.change.id}/object`, k2);
        assert(obj.status === 200 && obj.body?.change?.status === 'objected', 'HTTP: another keeper objects');
        const obj2 = await signedFetch('POST', `/api/enterprise/${ent}/keepers/changes/${rm.body.change.id}/object`, k2);
        assert(obj2.status === 400, 'HTTP: objecting to a closed change is refused');

        const sd = await signedFetch('POST', `/api/enterprise/${ent}/keepers/step-down`, k3);
        assert(sd.status === 200 && role(ent, k3.pubKeyHex) === null, 'HTTP: a keeper steps down');

        db.prepare("UPDATE members SET last_active_at = ? WHERE public_key = ?").run(new Date(Date.now() - 40 * 86400000).toISOString(), lead.pubKeyHex);
        const k4 = makeIdentity('HK4', 5), k5 = makeIdentity('HK5', 5);
        for (const k of [k4, k5]) adminAssignTreasuryOperator(ent, k.pubKeyHex, 'admin', 0);
        const prop = await signedFetch('POST', `/api/enterprise/${ent}/succession/propose`, k2, { candidatePubkey: k2.pubKeyHex });
        assert(prop.status === 200 && !!prop.body?.proposal?.deadlineAt, 'HTTP: succession proposal carries its deadline');
        const no = await signedFetch('POST', `/api/enterprise/${ent}/succession/${prop.body.proposal.id}/vote`, k4, { choice: 'no' });
        assert(no.status === 200 && no.body?.proposal?.noVotesCount === 1, 'HTTP: a No vote over HTTP');
        const junk = await signedFetch('POST', `/api/enterprise/${ent}/succession/${prop.body.proposal.id}/vote`, k5, { choice: 'abstain' });
        assert(junk.status === 400, 'HTTP: an unknown choice is refused');
    }

    console.log(`\n${passed}/${run} checks passed.`);
    process.exit(0);
}

main().catch(e => { console.error(e); console.log(`\n${passed}/${run} checks passed before failure.`); process.exit(1); });
