/**
 * Slice 6: Enterprise Keepers & Lead Succession Tests (docs/the-commons.md §2.3, §2.4 Rule 3, §2.6)
 *
 * Verifies:
 * 1. ASK TO JOIN AS A KEEPER:
 *    - request + approve creates the keeper with the pledged backing.
 *    - pledge that was valid at request but exceeds available_to_back at approval is rejected.
 *    - only lead/sole keeper/admin can approve (ordinary keeper/stranger cannot).
 *    - no two pending requests from one member for one enterprise.
 *    - declining leaves no keeper row and no backing.
 *    - completed (wound-up) enterprise accepts no requests.
 *    - pledge of 0 is valid: someone who helps run it without backing it.
 *
 * 2. LEAD SUCCESSION WITHOUT AN ADMIN (§2.3):
 *    - no proposal before 30 days of inactivity.
 *    - strict majority of other keepers moves the lead role.
 *    - a tie does not move the lead role.
 *    - old lead becomes an ordinary keeper and keeps their backing.
 *    - lead returning (node activity signal) cancels active proposal.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-enterprise-keepers-slice6.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import {
    initStateEngine, createTreasury, transfer, getBalance,
    adminAssignTreasuryOperator, initiateWindUp, finaliseWindUp,
    getEnterpriseFloor, getAvailableBacking, getEnterprisePledges,
    treasuryKeepers, isLeadOrSoleKeeperOrAdmin,
    requestToJoinEnterprise, getKeeperRequests, approveKeeperRequest, declineKeeperRequest,
    getLeadInactivity, proposeLeadSuccession, voteLeadSuccession, getSuccessionProposals,
    cancelActiveSuccessionIfLeadActive,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { recordActivity } from './engine/members.js';

const PORT = 8626;
const BASE = `https://localhost:${PORT}`;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else {
        console.error(`✗ ${msg}`);
        throw new Error(`Assertion failed: ${msg}`);
    }
}

function giveEarnedCredit(pubkey: string, targetEarned: number) {
    if (targetEarned <= 0) return;
    let vNeeded = Math.ceil((5000 * targetEarned) / (1920 - targetEarned));
    let peerIndex = 0;
    while (vNeeded > 0) {
        const tradeAmount = Math.min(vNeeded, 400);
        const peerKey = `peer-${pubkey.slice(0, 8)}-${peerIndex++}`;
        const now = new Date().toISOString();
        db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, avatar_url, joined_at, status) VALUES (?, ?, 'avatar', ?, 'active')`).run(peerKey, `Peer${peerIndex}`, now);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 1000, 0)`).run(peerKey);
        const pid = `post-ec-${crypto.randomUUID()}`;
        db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status) VALUES (?, 'offer', 'misc', 'goods', 'description', ?, ?, 'completed')`).run(pid, tradeAmount, peerKey);
        db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status) VALUES (?, ?, ?, ?, ?, 'completed')`).run(`mtx-ec-${crypto.randomUUID()}`, pid, pubkey, peerKey, tradeAmount);
        vNeeded -= tradeAmount;
    }
}

function makeIdentity(callsign: string, earnedCredit = 0) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const now = new Date().toISOString();
    db.prepare(`
        INSERT OR REPLACE INTO members (public_key, callsign, avatar_url, joined_at, status, can_operate, last_active_at)
        VALUES (?, ?, 'data:image/png;base64,iVBORw0KGgo=', ?, 'active', 1, ?)
    `).run(pubKeyHex, callsign, now, now);
    db.prepare(`INSERT OR REPLACE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 1000, 0)`).run(pubKeyHex);
    if (earnedCredit > 0) {
        giveEarnedCredit(pubKeyHex, earnedCredit);
    }
    return { pubKeyHex, privateKey, callsign };
}


async function signedFetch(method: 'GET' | 'POST', path: string, id: { pubKeyHex: string; privateKey: crypto.KeyObject }, body?: any) {
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
    console.log('── Initializing State & TLS ──');
    await initTls();
    initStateEngine();

    // =========================================================================
    // FEATURE 1: ASK TO JOIN AS A KEEPER
    // =========================================================================
    console.log('\n── Feature 1: Ask to Join as a Keeper ──');

    const admin = makeIdentity('AdminGenesis', 200);
    db.prepare("INSERT OR REPLACE INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'admin', 'system')").run(admin.pubKeyHex);

    const lead1 = makeIdentity('Lead1', 100);
    const keeper2 = makeIdentity('Keeper2', 50);
    const applicant1 = makeIdentity('Applicant1', 80);
    const stranger = makeIdentity('Stranger', 20);

    const { publicKey: ent1 } = createTreasury('EnterpriseAlpha', 'avatar1', 0);
    // Bind lead1 as lead keeper
    adminAssignTreasuryOperator(ent1, lead1.pubKeyHex, 'admin', 0);
    db.prepare("UPDATE treasury_operators SET role = 'lead' WHERE treasury_pubkey = ? AND member_pubkey = ?").run(ent1, lead1.pubKeyHex);
    // Bind keeper2 as ordinary keeper
    adminAssignTreasuryOperator(ent1, keeper2.pubKeyHex, 'admin', 0);

    assert(isLeadOrSoleKeeperOrAdmin(ent1, lead1.pubKeyHex) === true, 'Lead keeper passes authority predicate');
    assert(isLeadOrSoleKeeperOrAdmin(ent1, admin.pubKeyHex) === true, 'Admin passes authority predicate');
    assert(isLeadOrSoleKeeperOrAdmin(ent1, keeper2.pubKeyHex) === false, 'Ordinary keeper fails authority predicate when lead exists');
    assert(isLeadOrSoleKeeperOrAdmin(ent1, stranger.pubKeyHex) === false, 'Stranger fails authority predicate');

    // 1.1 Completed enterprise accepts no requests
    const { publicKey: woundUpEnt } = createTreasury('WoundUpEnterprise', 'avatar2', 0);
    adminAssignTreasuryOperator(woundUpEnt, lead1.pubKeyHex, 'admin', 0);
    db.prepare("UPDATE treasury_operators SET role = 'lead' WHERE treasury_pubkey = ? AND member_pubkey = ?").run(woundUpEnt, lead1.pubKeyHex);
    initiateWindUp(woundUpEnt, lead1.pubKeyHex);
    // Fast forward 8 days to finalise
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE members SET wind_up_initiated_at = ? WHERE public_key = ?").run(eightDaysAgo, woundUpEnt);
    finaliseWindUp(woundUpEnt, lead1.pubKeyHex);
    const woundUpRow = db.prepare("SELECT status FROM members WHERE public_key = ?").get(woundUpEnt) as any;
    assert(woundUpRow.status === 'completed', 'WoundUpEnterprise is in completed status');

    let completedThrew = false;
    try {
        requestToJoinEnterprise(woundUpEnt, applicant1.pubKeyHex, 10);
    } catch (e: any) {
        completedThrew = true;
        assert(e.message.includes('Completed enterprise accepts no requests'), 'Completed enterprise rejects join requests');
    }
    assert(completedThrew, 'Completed enterprise throws on join request');

    // 1.2 Request with pledge of 0 is valid
    const zeroReq = requestToJoinEnterprise(ent1, applicant1.pubKeyHex, 0);
    assert(zeroReq.status === 'pending', 'Request with pledge 0 created successfully as pending');
    assert(zeroReq.pledgedBacking === 0, 'Pledged backing is 0');

    // 1.3 No two pending requests from one member for one enterprise
    let dupThrew = false;
    try {
        requestToJoinEnterprise(ent1, applicant1.pubKeyHex, 10);
    } catch (e: any) {
        dupThrew = true;
        assert(e.message.includes('pending request already exists'), 'Duplicate pending request rejected');
    }
    assert(dupThrew, 'Duplicate pending request threw');

    // 1.4 Only lead/sole keeper/admin can approve or decline
    let ordinaryApproveThrew = false;
    try {
        approveKeeperRequest(zeroReq.id, keeper2.pubKeyHex);
    } catch (e: any) {
        ordinaryApproveThrew = true;
        assert(e.message.includes('Only the lead keeper, sole keeper, or admin'), 'Ordinary keeper cannot approve');
    }
    assert(ordinaryApproveThrew, 'Ordinary keeper approve attempt threw');

    let strangerApproveThrew = false;
    try {
        approveKeeperRequest(zeroReq.id, stranger.pubKeyHex);
    } catch (e: any) {
        strangerApproveThrew = true;
        assert(e.message.includes('Only the lead keeper, sole keeper, or admin'), 'Stranger cannot approve');
    }
    assert(strangerApproveThrew, 'Stranger approve attempt threw');

    // 1.5 Declining leaves no keeper row and no backing
    const declineRes = declineKeeperRequest(zeroReq.id, lead1.pubKeyHex);
    assert(declineRes.ok === true, 'Decline request succeeded');
    const declReq = db.prepare("SELECT status FROM enterprise_keeper_requests WHERE id = ?").get(zeroReq.id) as any;
    assert(declReq.status === 'declined', 'Request marked as declined');
    const noOpRow = db.prepare("SELECT 1 FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?").get(ent1, applicant1.pubKeyHex);
    assert(!noOpRow, 'No row in treasury_operators for declined applicant');
    const noPledgeRow = db.prepare("SELECT 1 FROM enterprise_pledges WHERE enterprise = ? AND keeper = ?").get(ent1, applicant1.pubKeyHex);
    assert(!noPledgeRow, 'No row in enterprise_pledges for declined applicant');

    // 1.6 Request + approve creates the keeper with the pledged backing
    assert(getAvailableBacking(applicant1.pubKeyHex) === 80, 'Applicant1 has 80 available to back');
    const backedReq = requestToJoinEnterprise(ent1, applicant1.pubKeyHex, 50);
    assert(backedReq.pledgedBacking === 50, 'Request created with 50 backing');

    const approveRes = approveKeeperRequest(backedReq.id, lead1.pubKeyHex);
    assert(approveRes.ok === true, 'Approval succeeded');
    assert(approveRes.backing === 50, 'Approved backing is 50');

    // Verify treasury_operators row
    const opRow = db.prepare("SELECT * FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?").get(ent1, applicant1.pubKeyHex) as any;
    assert(!!opRow, 'Applicant is now in treasury_operators');
    assert(opRow.role === 'keeper', 'Role is keeper');
    assert(opRow.backing === 50, 'Operator backing is 50');

    // Verify enterprise_pledges row
    const pledges = getEnterprisePledges(ent1);
    const applicantPledge = pledges.find(p => p.keeper === applicant1.pubKeyHex);
    assert(!!applicantPledge, 'Pledge found in enterprise_pledges');
    assert(applicantPledge?.amount === 50, 'Pledged amount is 50 in enterprise_pledges');

    // Verify enterprise floor updated
    const entFloor = getEnterpriseFloor(ent1);
    assert(entFloor.derivedAllowance === 50, 'Enterprise derived allowance is 50');
    assert(entFloor.floor === -50, 'Enterprise floor is -50');

    // Verify applicant available backing decreased across all enterprises
    assert(getAvailableBacking(applicant1.pubKeyHex) === 30, 'Applicant1 available backing reduced from 80 to 30');

    // 1.7 Server-side re-validation at approval: pledge valid at request but exceeds available_to_back at approval is rejected
    const applicant2 = makeIdentity('Applicant2', 40);
    assert(getAvailableBacking(applicant2.pubKeyHex) === 40, 'Applicant2 has 40 available to back');

    const reqValidAtStart = requestToJoinEnterprise(ent1, applicant2.pubKeyHex, 40);
    assert(reqValidAtStart.status === 'pending', 'Request with 40 was valid at request time');

    // Now applicant2 pledges 30 to another enterprise, so available_to_back drops to 10
    const { publicKey: entOther } = createTreasury('EnterpriseOther', 'avatar3', 0);
    adminAssignTreasuryOperator(entOther, applicant2.pubKeyHex, 'admin', 0);
    // Directly insert pledge for applicant2 in entOther
    db.prepare(`
        INSERT INTO enterprise_pledges (id, keeper, enterprise, amount, pledged_at, released_at)
        VALUES (?, ?, ?, ?, ?, NULL)
    `).run(crypto.randomUUID(), applicant2.pubKeyHex, entOther, 30, new Date().toISOString());

    assert(getAvailableBacking(applicant2.pubKeyHex) === 10, 'Applicant2 available to back is now 10 (less than 40)');

    let approveOverpledgeThrew = false;
    try {
        approveKeeperRequest(reqValidAtStart.id, lead1.pubKeyHex);
    } catch (e: any) {
        approveOverpledgeThrew = true;
        assert(e.message.includes('exceeds available earned credit at approval'), 'Approval rejected when pledge exceeds available at approval');
    }
    assert(approveOverpledgeThrew, 'Re-validation at approval threw when standing dropped');

    // Ensure applicant2 was NOT added as keeper to ent1
    const noOpEnt1 = db.prepare("SELECT 1 FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?").get(ent1, applicant2.pubKeyHex);
    assert(!noOpEnt1, 'Applicant2 was not added as operator to ent1');

    // 1.8 Sole keeper can approve
    const { publicKey: soleEnt } = createTreasury('SoleEnterprise', 'avatar4', 0);
    const soleKeeper = makeIdentity('SoleKeeper', 50);
    adminAssignTreasuryOperator(soleEnt, soleKeeper.pubKeyHex, 'admin', 0);
    // role is 'keeper' by default, but opCount is 1 -> sole keeper!
    assert(isLeadOrSoleKeeperOrAdmin(soleEnt, soleKeeper.pubKeyHex) === true, 'Sole keeper is recognized as lead authority');

    const applicant3 = makeIdentity('Applicant3', 50);
    const soleReq = requestToJoinEnterprise(soleEnt, applicant3.pubKeyHex, 20);
    const soleApproveRes = approveKeeperRequest(soleReq.id, soleKeeper.pubKeyHex);
    assert(soleApproveRes.ok === true, 'Sole keeper successfully approved join request');
    assert(soleApproveRes.backing === 20, 'Backing recorded');

    // =========================================================================
    // FEATURE 2: LEAD SUCCESSION WITHOUT AN ADMIN (§2.3)
    // =========================================================================
    console.log('\n── Feature 2: Lead Succession Without an Admin ──');

    const { publicKey: succEnt } = createTreasury('SuccessionEnterprise', 'avatar5', 0);
    const oldLead = makeIdentity('OldLead', 100);
    adminAssignTreasuryOperator(succEnt, oldLead.pubKeyHex, 'admin', 30);
    db.prepare("UPDATE treasury_operators SET role = 'lead' WHERE treasury_pubkey = ? AND member_pubkey = ?").run(succEnt, oldLead.pubKeyHex);
    // Add backing pledge for oldLead
    db.prepare(`
        INSERT INTO enterprise_pledges (id, keeper, enterprise, amount, pledged_at, released_at)
        VALUES (?, ?, ?, 30, ?, NULL)
    `).run(crypto.randomUUID(), oldLead.pubKeyHex, succEnt, new Date().toISOString());

    const candKeeper = makeIdentity('CandKeeper', 60);
    adminAssignTreasuryOperator(succEnt, candKeeper.pubKeyHex, 'admin', 0);

    const voterKeeper1 = makeIdentity('VoterKeeper1', 60);
    adminAssignTreasuryOperator(succEnt, voterKeeper1.pubKeyHex, 'admin', 0);

    const voterKeeper2 = makeIdentity('VoterKeeper2', 60);
    adminAssignTreasuryOperator(succEnt, voterKeeper2.pubKeyHex, 'admin', 0);

    // Keepers: oldLead (lead), candKeeper, voterKeeper1, voterKeeper2 (total 3 other keepers: N = 3)
    // 2.1 No proposal before 30 days of inactivity
    const inactivityNow = getLeadInactivity(succEnt);
    assert(inactivityNow.isEligible === false, 'Lead is active today; not eligible for succession');

    let prematureProposeThrew = false;
    try {
        proposeLeadSuccession(succEnt, candKeeper.pubKeyHex, candKeeper.pubKeyHex);
    } catch (e: any) {
        prematureProposeThrew = true;
        assert(e.message.includes('within the last 30 days'), 'Proposal before 30 days rejected');
    }
    assert(prematureProposeThrew, 'Premature succession proposal threw');

    // Fast-forward lead inactivity to 20 days ago (still < 30)
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE members SET last_active_at = ? WHERE public_key = ?").run(twentyDaysAgo, oldLead.pubKeyHex);
    assert(getLeadInactivity(succEnt).isEligible === false, '20 days inactive is not eligible');

    let twentyDayThrew = false;
    try {
        proposeLeadSuccession(succEnt, candKeeper.pubKeyHex, candKeeper.pubKeyHex);
    } catch (e: any) {
        twentyDayThrew = true;
    }
    assert(twentyDayThrew, '20 days inactive proposal rejected');

    // 2.2 Set lead inactivity to 31 days ago (>= 30 days)
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE members SET last_active_at = ? WHERE public_key = ?").run(thirtyOneDaysAgo, oldLead.pubKeyHex);
    const inactivity31 = getLeadInactivity(succEnt);
    assert(inactivity31.isEligible === true, 'Lead with 31 days inactivity is eligible');
    assert(inactivity31.daysInactive >= 30, 'daysInactive >= 30');

    // 2.3 Majority moves it, a tie does not:
    // With 3 other keepers (candKeeper, voterKeeper1, voterKeeper2): N = 3.
    // Strict majority threshold: Math.floor(3 / 2) + 1 = 2 votes.
    // When candKeeper proposes: 1 vote cast. 1 is not >= 2, so it stays active!
    const propRes = proposeLeadSuccession(succEnt, candKeeper.pubKeyHex, candKeeper.pubKeyHex);
    assert(propRes.ok === true, 'Succession proposed');
    assert(propRes.executed === false, 'Proposal not yet executed with 1/3 votes');
    assert(propRes.proposal.status === 'active', 'Proposal status is active');
    assert(propRes.proposal.totalEligible === 3, '3 other keepers eligible');
    assert(propRes.proposal.requiredVotes === 2, '2 votes required for strict majority');
    assert(propRes.proposal.votesCount === 1, '1 vote currently recorded (proposer)');

    // Verify lead role has NOT moved yet
    const currentLeadOp = db.prepare("SELECT role FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?").get(succEnt, oldLead.pubKeyHex) as any;
    assert(currentLeadOp.role === 'lead', 'Old lead is still lead');

    // Check tie scenario:
    // Let's create an enterprise with N = 2 other keepers:
    // Required: Math.floor(2/2) + 1 = 2. 1 vote is 50% (tie between yes and no).
    const { publicKey: tieEnt } = createTreasury('TieEnterprise', 'avatarTie', 0);
    const tieLead = makeIdentity('TieLead', 100);
    adminAssignTreasuryOperator(tieEnt, tieLead.pubKeyHex, 'admin', 0);
    db.prepare("UPDATE treasury_operators SET role = 'lead' WHERE treasury_pubkey = ? AND member_pubkey = ?").run(tieEnt, tieLead.pubKeyHex);
    db.prepare("UPDATE members SET last_active_at = ? WHERE public_key = ?").run(thirtyOneDaysAgo, tieLead.pubKeyHex);

    const tieK1 = makeIdentity('TieK1', 50);
    const tieK2 = makeIdentity('TieK2', 50);
    adminAssignTreasuryOperator(tieEnt, tieK1.pubKeyHex, 'admin', 0);
    adminAssignTreasuryOperator(tieEnt, tieK2.pubKeyHex, 'admin', 0);

    // N = 2 other keepers. tieK1 proposes: 1 vote out of 2.
    const tieProp = proposeLeadSuccession(tieEnt, tieK1.pubKeyHex, tieK1.pubKeyHex);
    assert(tieProp.proposal.totalEligible === 2, 'TieEnterprise has 2 eligible other keepers');
    assert(tieProp.proposal.requiredVotes === 2, 'TieEnterprise requires 2 votes (strict majority of 2)');
    assert(tieProp.proposal.votesCount === 1, 'TieEnterprise has 1 vote');
    assert(tieProp.executed === false, 'A tie (1 of 2) does NOT move the role');
    assert(tieProp.proposal.status === 'active', 'Tie proposal stays active');

    // 2.4 Back to succEnt (N=3, currently 1 vote):
    // voterKeeper1 votes -> 2 votes out of 3.
    // 2 >= 2 -> Strict majority reached -> MOVES IT!
    const voteRes = voteLeadSuccession(propRes.proposal.id, voterKeeper1.pubKeyHex);
    assert(voteRes.ok === true, 'Vote registered');
    assert(voteRes.executed === true, 'Strict majority moves the lead role!');
    assert(voteRes.proposal.status === 'passed', 'Proposal marked as passed');
    assert(voteRes.proposal.votesCount === 2, '2 votes recorded');

    // 2.5 Verify old lead becomes ordinary keeper AND keeps their backing
    const updatedOldLead = db.prepare("SELECT role, backing FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?").get(succEnt, oldLead.pubKeyHex) as any;
    assert(updatedOldLead.role === 'keeper', 'Old lead role is now ordinary keeper');
    assert(updatedOldLead.backing === 30, 'Old lead keeps backing amount in treasury_operators');

    const oldLeadPledge = db.prepare("SELECT amount, released_at FROM enterprise_pledges WHERE enterprise = ? AND keeper = ?").get(succEnt, oldLead.pubKeyHex) as any;
    assert(oldLeadPledge.amount === 30 && oldLeadPledge.released_at === null, 'Old lead pledge is still active in enterprise_pledges');

    // Verify candidate became lead keeper
    const updatedCand = db.prepare("SELECT role FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?").get(succEnt, candKeeper.pubKeyHex) as any;
    assert(updatedCand.role === 'lead', 'Candidate is now lead keeper');

    // 2.6 The lead returning cancels it:
    // If the lead becomes active again before the vote completes, the proposal is cancelled
    const { publicKey: returnEnt } = createTreasury('ReturnEnterprise', 'avatarReturn', 0);
    const returningLead = makeIdentity('ReturningLead', 100);
    adminAssignTreasuryOperator(returnEnt, returningLead.pubKeyHex, 'admin', 0);
    db.prepare("UPDATE treasury_operators SET role = 'lead' WHERE treasury_pubkey = ? AND member_pubkey = ?").run(returnEnt, returningLead.pubKeyHex);
    db.prepare("UPDATE members SET last_active_at = ? WHERE public_key = ?").run(thirtyOneDaysAgo, returningLead.pubKeyHex);

    const retK1 = makeIdentity('RetK1', 50);
    const retK2 = makeIdentity('RetK2', 50);
    adminAssignTreasuryOperator(returnEnt, retK1.pubKeyHex, 'admin', 0);
    adminAssignTreasuryOperator(returnEnt, retK2.pubKeyHex, 'admin', 0);

    const retProp = proposeLeadSuccession(returnEnt, retK1.pubKeyHex, retK1.pubKeyHex);
    assert(retProp.proposal.status === 'active', 'Proposal is active');

    // Now the lead returns: records node activity!
    recordActivity(returningLead.pubKeyHex);
    const updatedLeadMember = db.prepare("SELECT last_active_at FROM members WHERE public_key = ?").get(returningLead.pubKeyHex) as any;
    assert(new Date(updatedLeadMember.last_active_at).getTime() > new Date(thirtyOneDaysAgo).getTime(), 'Lead recorded fresh activity');

    // Active proposal was cancelled immediately by recordActivity!
    const cancelledPropRow = db.prepare("SELECT status FROM enterprise_succession_proposals WHERE id = ?").get(retProp.proposal.id) as any;
    assert(cancelledPropRow.status === 'cancelled', 'Active proposal was cancelled when lead recorded node activity');

    // Any attempt to vote on cancelled proposal fails
    let voteCancelledThrew = false;
    try {
        voteLeadSuccession(retProp.proposal.id, retK2.pubKeyHex);
    } catch (e: any) {
        voteCancelledThrew = true;
        assert(e.message.includes('cancelled') || e.message.includes('no longer active'), 'Voting on cancelled proposal rejected');
    }
    assert(voteCancelledThrew, 'Vote on cancelled proposal threw');

    // =========================================================================
    // HTTP ROUTE LEVEL VERIFICATION
    // =========================================================================
    console.log('\n── HTTP Route Level Verification ──');
    await startHttpsServer(PORT);

    const httpLead = makeIdentity('HTTPLead', 100);
    const httpApplicant = makeIdentity('HTTPApplicant', 70);
    const httpStranger = makeIdentity('HTTPStranger', 20);

    const { publicKey: httpEnt } = createTreasury('HttpEnterprise', 'avatarHttp', 0);
    adminAssignTreasuryOperator(httpEnt, httpLead.pubKeyHex, 'admin', 0);
    db.prepare("UPDATE treasury_operators SET role = 'lead' WHERE treasury_pubkey = ? AND member_pubkey = ?").run(httpEnt, httpLead.pubKeyHex);

    // 1. Submit join request via HTTP
    const reqPostRes = await signedFetch('POST', `/api/enterprise/${httpEnt}/keepers/request`, httpApplicant, {
        pledgedBacking: 25,
    });
    assert(reqPostRes.status === 200, 'HTTP POST keepers/request returns 200');
    assert(reqPostRes.body?.success === true, 'HTTP request returned success');
    assert(reqPostRes.body?.request?.pledgedBacking === 25, 'HTTP pledgedBacking is 25');
    const httpReqId = reqPostRes.body?.request?.id;

    // 2. List requests via HTTP
    const listReqRes = await signedFetch('GET', `/api/enterprise/${httpEnt}/keepers/requests`, httpLead);
    assert(listReqRes.status === 200, 'HTTP GET keepers/requests returns 200');
    assert(listReqRes.body?.requests?.length === 1, 'HTTP returns 1 pending request');
    assert(listReqRes.body?.requests?.[0]?.callsign === 'HTTPApplicant', 'Applicant callsign included in response');

    // 3. Non-lead keeper/stranger cannot approve via HTTP
    const strangerApproveRes = await signedFetch('POST', `/api/enterprise/${httpEnt}/keepers/requests/${httpReqId}/approve`, httpStranger);
    assert(strangerApproveRes.status === 403, 'Stranger HTTP approve returns 403');

    // 4. Lead approves via HTTP
    const leadApproveRes = await signedFetch('POST', `/api/enterprise/${httpEnt}/keepers/requests/${httpReqId}/approve`, httpLead);
    assert(leadApproveRes.status === 200, 'Lead HTTP approve returns 200');
    assert(leadApproveRes.body?.success === true, 'Lead approve response success');
    assert(leadApproveRes.body?.backing === 25, 'Lead approve response backing 25');

    // 5. Test getTreasury endpoint returns keeperRequests & myPendingRequest & leadInactivity
    const getDetailRes = await signedFetch('GET', `/api/enterprise/${httpEnt}`, httpLead);
    assert(getDetailRes.status === 200, 'HTTP GET /api/enterprise/:id returns 200');
    assert(Array.isArray(getDetailRes.body?.keepers), 'Detail includes keepers array');
    assert(getDetailRes.body?.keepers?.some((k: any) => k.callsign === 'HTTPApplicant' && k.role === 'keeper'), 'Applicant is now keeper with role');
    assert(getDetailRes.body?.leadInactivity !== undefined, 'Detail includes leadInactivity');

    // 6. Succession via HTTP
    // Fast-forward httpLead inactivity to 35 days ago
    const thirtyFiveDaysAgo = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE members SET last_active_at = ? WHERE public_key = ?").run(thirtyFiveDaysAgo, httpLead.pubKeyHex);

    // httpApplicant proposes succession to make themselves lead
    const proposeSuccRes = await signedFetch('POST', `/api/enterprise/${httpEnt}/succession/propose`, httpApplicant, {
        candidatePubkey: httpApplicant.pubKeyHex,
    });
    assert(proposeSuccRes.status === 200, 'HTTP POST succession/propose returns 200');
    assert(proposeSuccRes.body?.success === true, 'HTTP succession propose succeeded');
    // Since httpApplicant was the only other keeper (N = 1), 1 >= 1 -> executed immediately!
    assert(proposeSuccRes.body?.executed === true, 'Sole other keeper immediately passes succession');

    // Check succession state via HTTP GET
    const succGetRes = await signedFetch('GET', `/api/enterprise/${httpEnt}/succession`, httpApplicant);
    assert(succGetRes.status === 200, 'HTTP GET succession returns 200');
    assert(succGetRes.body?.proposals?.length === 1, '1 succession proposal recorded');
    assert(succGetRes.body?.proposals?.[0]?.status === 'passed', 'Proposal status is passed');
    assert(succGetRes.body?.proposals?.[0]?.candidateCallsign === 'HTTPApplicant', 'Candidate is HTTPApplicant');
    assert(succGetRes.body?.proposals?.[0]?.votes?.length === 1, 'Proposer vote recorded and visible');

    console.log(`\n==============================================`);
    console.log(`🎉 All ${passed}/${run} tests passed successfully!`);
    console.log(`==============================================\n`);
    process.exit(0);
}

main().catch(err => {
    console.error('Test failed with error:', err);
    process.exit(1);
});
