// Convenor succession for Commons groups (answer B and decision 17, 2026-09-19).
//
// Groups hold no binding votes — a Poll is how a group asks what it thinks — with one exception borrowed from
// enterprise succession (state-engine.ts proposeLeadSuccession, #920): a group whose ONLY convenor has shown no
// activity on the node for 30 days can choose a new one.
//
//  - Who may propose: any active member of the group (role member; observers watch, the silent convenor is the
//    subject). The candidate is an active member too — proposing yourself is fine.
//  - Who votes: the same set, the electorate — active members with role 'member' whose account is active.
//    Yes or No; a vote cannot be changed; the proposal counts as the proposer's yes.
//  - Passing: more than half of the members who answer say yes. The vote runs 14 days (no deadline-less
//    proposals); it closes early the moment the result can no longer change. At the deadline, yes must
//    outnumber no.
//  - The convenor coming back — any signed activity on the node after the proposal opened — cancels it.
//  - Passing makes the candidate convenor and the silent convenor an ordinary member.
//
// Every step writes a line into the group's chat. Ballots are secret, as for Decisions (answer I): members see
// the totals and their own vote, never who voted how.

import crypto from 'node:crypto';
import { db } from '../db/db.js';
import { postGroupSystemLine, callsignOf, GroupSystemType, loadGroupForThread } from './group-thread.js';
import type { MessagingCallbacks } from './messaging.js';

export const GROUP_CONVENOR_SILENCE_MS = 30 * 24 * 60 * 60 * 1000;
export const GROUP_SUCCESSION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export type GroupSuccessionClosedReason = 'rejected' | 'convenor_returned' | 'candidate_gone' | 'no_longer_needed';
type Outcome = 'passed' | GroupSuccessionClosedReason | 'open';

export interface ConvenorSilence {
    /** The group's only active convenor, or null when there are none or several. */
    convenorPubkey: string | null;
    convenorCallsign: string | null;
    lastActiveAt: string | null;
    daysInactive: number;
    /** A member may propose a new convenor now. */
    isEligible: boolean;
}

export interface GroupSuccessionProposalInfo {
    id: string;
    groupId: string;
    convenorPubkey: string;
    convenorCallsign: string;
    candidatePubkey: string;
    candidateCallsign: string;
    proposerPubkey: string;
    proposerCallsign: string;
    status: 'active' | 'passed' | 'cancelled';
    closedReason: GroupSuccessionClosedReason | null;
    createdAt: string;
    deadlineAt: string;
    executedAt: string | null;
    yesCount: number;
    noCount: number;
    /** How many members may vote. */
    electorateSize: number;
    /** The viewer's own vote, never anyone else's. */
    myVote: 'yes' | 'no' | null;
    canVote: boolean;
}

const activeConvenors = (groupId: string): string[] =>
    (db.prepare("SELECT member_pubkey FROM group_members WHERE group_id = ? AND role = 'convenor' AND status = 'active'").all(groupId) as any[])
        .map(r => r.member_pubkey);

export function getConvenorSilence(groupId: string, nowMs = Date.now()): ConvenorSilence {
    const convenors = activeConvenors(groupId);
    if (convenors.length !== 1) {
        return { convenorPubkey: null, convenorCallsign: null, lastActiveAt: null, daysInactive: 0, isEligible: false };
    }
    const m = db.prepare('SELECT callsign, last_active_at, joined_at FROM members WHERE public_key = ?').get(convenors[0]) as any;
    const lastActiveAt: string | null = m?.last_active_at || m?.joined_at || null;
    const lastMs = lastActiveAt ? Date.parse(lastActiveAt) : 0;
    const msInactive = Math.max(0, nowMs - (Number.isFinite(lastMs) ? lastMs : 0));
    return {
        convenorPubkey: convenors[0],
        convenorCallsign: m?.callsign ?? null,
        lastActiveAt,
        daysInactive: msInactive / (24 * 60 * 60 * 1000),
        isEligible: msInactive >= GROUP_CONVENOR_SILENCE_MS,
    };
}

/** Active members (role member) of the group whose account is active — who may propose, stand and vote. */
export function successionElectorate(groupId: string): string[] {
    return (db.prepare(`
        SELECT gm.member_pubkey FROM group_members gm JOIN members m ON m.public_key = gm.member_pubkey
        WHERE gm.group_id = ? AND gm.status = 'active' AND gm.role = 'member' AND m.status = 'active'
    `).all(groupId) as any[]).map(r => r.member_pubkey);
}

/** Has the convenor a proposal targets done anything on the node since it opened? */
function convenorReturnedSince(prop: any): boolean {
    const r = db.prepare('SELECT last_active_at FROM members WHERE public_key = ?').get(prop.convenor_pubkey) as any;
    return !!r?.last_active_at && Date.parse(r.last_active_at) > Date.parse(prop.created_at);
}

function tally(prop: any, electorate: string[]): { yes: number; no: number } {
    const inElectorate = new Set(electorate);
    const votes = db.prepare('SELECT voter_pubkey, choice FROM group_convenor_votes WHERE proposal_id = ?').all(prop.id) as any[];
    let yes = 0, no = 0;
    // Only the votes of people who can still vote count: someone who has since left the group has no say.
    for (const v of votes) {
        if (!inElectorate.has(v.voter_pubkey)) continue;
        if (v.choice === 'yes') yes++; else no++;
    }
    return { yes, no };
}

const REASON_TEXT: Record<GroupSuccessionClosedReason, string> = {
    rejected: 'not enough members said yes',
    convenor_returned: 'the convenor is back',
    candidate_gone: 'the person proposed is no longer a member',
    no_longer_needed: 'the group has another convenor now',
};

function closeProposal(cb: MessagingCallbacks, prop: any, reason: GroupSuccessionClosedReason): boolean {
    const res = db.prepare("UPDATE group_convenor_proposals SET status = 'cancelled', closed_reason = ? WHERE id = ? AND status = 'active'")
        .run(reason, prop.id);
    if (res.changes === 0) return false;
    postGroupSystemLine(cb, prop.group_id, GroupSystemType.CONVENOR_VOTE_CLOSED,
        `The vote to make ${callsignOf(prop.candidate_pubkey)} convenor closed: ${REASON_TEXT[reason]}.`,
        { proposalId: prop.id, candidatePubkey: prop.candidate_pubkey, reason });
    return true;
}

/**
 * Decide an active proposal if its result is settled. Before the deadline it closes only when the result can no
 * longer change: yes already ahead of every possible no (passed), or no already level with every possible yes
 * (rejected). At or after the deadline (`final`) yes must outnumber no among those who answered.
 */
function settle(cb: MessagingCallbacks, prop: any, final: boolean, nowIso: string): Outcome {
    if (convenorReturnedSince(prop)) { closeProposal(cb, prop, 'convenor_returned'); return 'convenor_returned'; }
    const convenors = activeConvenors(prop.group_id);
    if (convenors.length !== 1 || convenors[0] !== prop.convenor_pubkey) {
        closeProposal(cb, prop, 'no_longer_needed');
        return 'no_longer_needed';
    }
    const electorate = successionElectorate(prop.group_id);
    if (!electorate.includes(prop.candidate_pubkey)) { closeProposal(cb, prop, 'candidate_gone'); return 'candidate_gone'; }

    const { yes, no } = tally(prop, electorate);
    const outstanding = Math.max(0, electorate.length - yes - no);
    const passes = final ? yes > no : yes > no + outstanding;
    const fails = final ? yes <= no : no >= yes + outstanding;
    if (passes) {
        db.transaction(() => {
            db.prepare("UPDATE group_members SET role = 'member', updated_at = ? WHERE group_id = ? AND member_pubkey = ?")
                .run(nowIso, prop.group_id, prop.convenor_pubkey);
            db.prepare("UPDATE group_members SET role = 'convenor', updated_at = ? WHERE group_id = ? AND member_pubkey = ?")
                .run(nowIso, prop.group_id, prop.candidate_pubkey);
            db.prepare("UPDATE group_convenor_proposals SET status = 'passed', executed_at = ? WHERE id = ?").run(nowIso, prop.id);
        })();
        postGroupSystemLine(cb, prop.group_id, GroupSystemType.CONVENOR_CHOSEN,
            `Members chose ${callsignOf(prop.candidate_pubkey)} as convenor (${yes} yes, ${no} no).`,
            { proposalId: prop.id, candidatePubkey: prop.candidate_pubkey, previousConvenorPubkey: prop.convenor_pubkey, yes, no });
        return 'passed';
    }
    if (fails) { closeProposal(cb, prop, 'rejected'); return 'rejected'; }
    return 'open';
}

function toInfo(r: any, viewer?: string): GroupSuccessionProposalInfo {
    const electorate = successionElectorate(r.group_id);
    const { yes, no } = tally(r, electorate);
    const mine = viewer
        ? (db.prepare('SELECT choice FROM group_convenor_votes WHERE proposal_id = ? AND voter_pubkey = ?').get(r.id, viewer) as any)?.choice ?? null
        : null;
    return {
        id: r.id,
        groupId: r.group_id,
        convenorPubkey: r.convenor_pubkey,
        convenorCallsign: callsignOf(r.convenor_pubkey),
        candidatePubkey: r.candidate_pubkey,
        candidateCallsign: callsignOf(r.candidate_pubkey),
        proposerPubkey: r.proposer_pubkey,
        proposerCallsign: callsignOf(r.proposer_pubkey),
        status: r.status,
        closedReason: r.closed_reason ?? null,
        createdAt: r.created_at,
        deadlineAt: r.deadline_at,
        executedAt: r.executed_at ?? null,
        yesCount: yes,
        noCount: no,
        electorateSize: electorate.length,
        myVote: mine === 'yes' || mine === 'no' ? mine : null,
        canVote: r.status === 'active' && !!viewer && !mine && electorate.includes(viewer),
    };
}

/** Settle proposals past their deadline (all groups, or one). The scheduler runs this every minute. */
export function tickGroupSuccession(cb: MessagingCallbacks, asOfMs = Date.now(), groupId?: string): { passed: number; closed: number } {
    const nowIso = new Date(asOfMs).toISOString();
    const due = (groupId
        ? db.prepare("SELECT * FROM group_convenor_proposals WHERE status = 'active' AND deadline_at <= ? AND group_id = ?").all(nowIso, groupId)
        : db.prepare("SELECT * FROM group_convenor_proposals WHERE status = 'active' AND deadline_at <= ?").all(nowIso)) as any[];
    let passed = 0, closed = 0;
    for (const p of due) {
        const o = settle(cb, p, true, nowIso);
        if (o === 'passed') passed++; else if (o !== 'open') closed++;
    }
    return { passed, closed };
}

/**
 * The convenor did something on the node: every open proposal against them closes. Called from the activity
 * hook on each signed write, so it is one indexed lookup when there is nothing to do.
 */
export function cancelGroupSuccessionIfConvenorActive(cb: MessagingCallbacks, convenorPubkey: string): number {
    const open = db.prepare("SELECT * FROM group_convenor_proposals WHERE convenor_pubkey = ? AND status = 'active'").all(convenorPubkey) as any[];
    let n = 0;
    for (const p of open) if (closeProposal(cb, p, 'convenor_returned')) n++;
    return n;
}

/** Propose a member as the group's convenor. The proposal is the proposer's yes. */
export function proposeGroupConvenor(
    cb: MessagingCallbacks,
    groupId: string,
    proposerPubkey: string,
    candidatePubkey: string,
): { proposal: GroupSuccessionProposalInfo; executed: boolean } {
    loadGroupForThread(groupId);
    tickGroupSuccession(cb, Date.now(), groupId);

    const existing = db.prepare("SELECT * FROM group_convenor_proposals WHERE group_id = ? AND status = 'active'").get(groupId) as any;
    if (existing && settle(cb, existing, false, new Date().toISOString()) === 'open') {
        throw new Error('A vote on a new convenor is already open for this group');
    }

    const silence = getConvenorSilence(groupId);
    if (!silence.convenorPubkey) throw new Error('Only a group with a single convenor can choose a new one this way');
    if (!silence.isEligible) throw new Error('The convenor has been active on the node within the last 30 days');

    const electorate = successionElectorate(groupId);
    if (!electorate.includes(proposerPubkey)) throw new Error('Only an active member of this group may propose a convenor');
    if (candidatePubkey === silence.convenorPubkey) throw new Error('The candidate cannot be the current convenor');
    if (!electorate.includes(candidatePubkey)) throw new Error('The candidate must be an active member of this group');

    const id = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const deadlineAt = new Date(Date.now() + GROUP_SUCCESSION_WINDOW_MS).toISOString();
    db.transaction(() => {
        db.prepare(`
            INSERT INTO group_convenor_proposals (id, group_id, convenor_pubkey, candidate_pubkey, proposer_pubkey, status, created_at, deadline_at)
            VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
        `).run(id, groupId, silence.convenorPubkey, candidatePubkey, proposerPubkey, nowIso, deadlineAt);
        db.prepare("INSERT INTO group_convenor_votes (proposal_id, voter_pubkey, choice, voted_at) VALUES (?, ?, 'yes', ?)")
            .run(id, proposerPubkey, nowIso);
    })();

    const who = proposerPubkey === candidatePubkey
        ? `${callsignOf(proposerPubkey)} offered to be convenor`
        : `${callsignOf(proposerPubkey)} proposed ${callsignOf(candidatePubkey)} as convenor`;
    postGroupSystemLine(cb, groupId, GroupSystemType.CONVENOR_VOTE_OPENED,
        `${who}, because ${callsignOf(silence.convenorPubkey)} has not been active for 30 days. Members have 14 days to vote.`,
        { proposalId: id, candidatePubkey, proposerPubkey, deadlineAt });

    const row = db.prepare('SELECT * FROM group_convenor_proposals WHERE id = ?').get(id) as any;
    const outcome = settle(cb, row, false, nowIso);
    const after = db.prepare('SELECT * FROM group_convenor_proposals WHERE id = ?').get(id) as any;
    return { proposal: toInfo(after, proposerPubkey), executed: outcome === 'passed' };
}

/** Vote yes or no. A vote cannot be changed. */
export function voteGroupConvenor(
    cb: MessagingCallbacks,
    proposalId: string,
    voterPubkey: string,
    choice: 'yes' | 'no',
): { proposal: GroupSuccessionProposalInfo; executed: boolean } {
    if (choice !== 'yes' && choice !== 'no') throw new Error("Vote must be 'yes' or 'no'");
    const prop = db.prepare('SELECT * FROM group_convenor_proposals WHERE id = ?').get(proposalId) as any;
    if (!prop) throw new Error('Convenor proposal not found');
    tickGroupSuccession(cb, Date.now(), prop.group_id);
    const nowIso = new Date().toISOString();
    const cur = db.prepare('SELECT * FROM group_convenor_proposals WHERE id = ?').get(proposalId) as any;
    if (cur.status !== 'active' || settle(cb, cur, false, nowIso) !== 'open') throw new Error('This vote has closed');

    if (!successionElectorate(prop.group_id).includes(voterPubkey)) {
        throw new Error('Only an active member of this group may vote on its convenor');
    }
    if (db.prepare('SELECT 1 FROM group_convenor_votes WHERE proposal_id = ? AND voter_pubkey = ?').get(proposalId, voterPubkey)) {
        throw new Error('You have already voted on this proposal');
    }
    db.prepare('INSERT INTO group_convenor_votes (proposal_id, voter_pubkey, choice, voted_at) VALUES (?, ?, ?, ?)')
        .run(proposalId, voterPubkey, choice, nowIso);
    const outcome = settle(cb, cur, false, nowIso);
    const after = db.prepare('SELECT * FROM group_convenor_proposals WHERE id = ?').get(proposalId) as any;
    return { proposal: toInfo(after, voterPubkey), executed: outcome === 'passed' };
}

/** Silence and proposals for one group, as one member sees them (totals and their own vote only). */
export function getGroupSuccession(cb: MessagingCallbacks, groupId: string, viewerPubkey?: string): {
    silence: ConvenorSilence;
    proposals: GroupSuccessionProposalInfo[];
    canPropose: boolean;
} {
    loadGroupForThread(groupId);
    tickGroupSuccession(cb, Date.now(), groupId);
    const active = db.prepare("SELECT * FROM group_convenor_proposals WHERE group_id = ? AND status = 'active'").get(groupId) as any;
    if (active) settle(cb, active, false, new Date().toISOString());
    const silence = getConvenorSilence(groupId);
    const rows = db.prepare('SELECT * FROM group_convenor_proposals WHERE group_id = ? ORDER BY created_at DESC').all(groupId) as any[];
    const proposals = rows.map(r => toInfo(r, viewerPubkey));
    const stillOpen = proposals.some(p => p.status === 'active');
    return {
        silence,
        proposals,
        canPropose: silence.isEligible && !stillOpen && !!viewerPubkey && successionElectorate(groupId).includes(viewerPubkey),
    };
}
