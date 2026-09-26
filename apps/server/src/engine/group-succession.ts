// Convenor succession for Commons groups (answer B and decision 17, 2026-09-19; extended to the lead convenor
// 2026-09-23).
//
// Groups hold no binding votes — a Poll is how a group asks what it thinks — with one exception borrowed from
// enterprise succession (state-engine.ts proposeLeadSuccession, #920): a group whose LEAD CONVENOR has shown no
// activity on the node for 30 days can choose a new one. Until 2026-09-23 this covered only a group whose SOLE
// convenor was silent, which left a silent lead with other convenors under them unreachable — the lead cannot be
// removed or demoted by anyone, so the silence vote is the group's own way out.
//
//  - The subject: the group's lead convenor. (A group with no lead at all — no active convenor — has nobody to
//    replace.)
//  - The electorate: the group's OTHER active convenors, or its active members (role 'member') when the lead is
//    its only convenor. Whoever they are, they propose, stand and vote; observers watch, and the silent lead has
//    no vote on their own replacement. Proposing yourself is fine.
//  - Yes or No; a vote cannot be changed; the proposal counts as the proposer's yes.
//  - Passing: more than half of those who answer say yes. The vote runs 14 days (no deadline-less proposals); it
//    closes early the moment the result can no longer change. At the deadline, yes must outnumber no.
//  - The lead coming back — any signed activity on the node after the proposal opened — cancels it.
//  - Passing makes the candidate a convenor and the group's lead. The silent lead keeps the convenor role when
//    the other convenors were the ones who voted — they lost the lead, not the role, exactly as an enterprise
//    lead keeper does. When the MEMBERS voted, because the lead was the group's only convenor, the silent lead
//    becomes an ordinary member: a group that has just voted its only convenor out cannot be left with them
//    still holding convenor powers.
//
// Every step writes a line into the group's chat. Ballots are secret, as for Decisions (answer I): members see
// the totals and their own vote, never who voted how.

import crypto from 'node:crypto';
import { db } from '../db/db.js';
import { getGroupLead } from '@beanpool/engine';
import { postGroupSystemLine, callsignOf, GroupSystemType, loadGroupForThread } from './group-thread.js';
import type { MessagingCallbacks } from './messaging.js';

export const GROUP_CONVENOR_SILENCE_MS = 30 * 24 * 60 * 60 * 1000;
export const GROUP_SUCCESSION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export type GroupSuccessionClosedReason = 'rejected' | 'convenor_returned' | 'candidate_gone' | 'no_longer_needed';
type Outcome = 'passed' | GroupSuccessionClosedReason | 'open';

export interface ConvenorSilence {
    /**
     * The group's LEAD convenor — the one a vote can replace — or null when the group has no active convenor.
     * Kept under its old name: every client reads `silence.convenorPubkey`.
     */
    convenorPubkey: string | null;
    convenorCallsign: string | null;
    lastActiveAt: string | null;
    daysInactive: number;
    /** 30 days with no recorded activity on the node. */
    isSilent: boolean;
    /** Silent AND somebody is left who may vote — only then can a proposal open. */
    isEligible: boolean;
    /** Who votes: the lead's fellow convenors, or the group's members when the lead is its only convenor. */
    electorate: 'convenors' | 'members';
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

/** The group's other active convenors, account active and a member's (not a visitor's row) — the electorate whenever there is one. */
function otherActiveConvenors(groupId: string, leadPubkey: string): string[] {
    return (db.prepare(`
        SELECT gm.member_pubkey FROM group_members gm JOIN members m ON m.public_key = gm.member_pubkey
        WHERE gm.group_id = ? AND gm.status = 'active' AND gm.role = 'convenor' AND m.status = 'active' AND m.is_visitor = 0
          AND gm.member_pubkey != ?
    `).all(groupId, leadPubkey) as any[]).map(r => r.member_pubkey);
}

/** Who votes on replacing this lead: their fellow convenors, or the members when the lead is the only convenor. */
export function electorateKind(groupId: string, leadPubkey: string): 'convenors' | 'members' {
    return otherActiveConvenors(groupId, leadPubkey).length > 0 ? 'convenors' : 'members';
}

export function getConvenorSilence(groupId: string, nowMs = Date.now()): ConvenorSilence {
    const lead = getGroupLead(db, groupId);
    if (!lead) {
        return {
            convenorPubkey: null, convenorCallsign: null, lastActiveAt: null, daysInactive: 0,
            isSilent: false, isEligible: false, electorate: 'members',
        };
    }
    const m = db.prepare('SELECT callsign, last_active_at, joined_at FROM members WHERE public_key = ?').get(lead) as any;
    const lastActiveAt: string | null = m?.last_active_at || m?.joined_at || null;
    const lastMs = lastActiveAt ? Date.parse(lastActiveAt) : 0;
    const msInactive = Math.max(0, nowMs - (Number.isFinite(lastMs) ? lastMs : 0));
    const electorate = electorateKind(groupId, lead);
    const isSilent = msInactive >= GROUP_CONVENOR_SILENCE_MS;
    return {
        convenorPubkey: lead,
        convenorCallsign: m?.callsign ?? null,
        lastActiveAt,
        daysInactive: msInactive / (24 * 60 * 60 * 1000),
        isSilent,
        // A vote nobody can vote in is not eligible: a lead alone in their group has no electorate.
        isEligible: isSilent && successionElectorate(groupId, lead).length > 0,
        electorate,
    };
}

/**
 * Who may propose, stand and vote: the lead's fellow active convenors, or — when the lead is the group's only
 * convenor — its active members with role 'member'. Accounts must be active, and a member's (a visitor's row
 * votes on nothing), either way. Observers never vote, and the lead has no vote on their own replacement.
 */
export function successionElectorate(groupId: string, leadPubkey?: string | null): string[] {
    const lead = leadPubkey === undefined ? getGroupLead(db, groupId) : leadPubkey;
    if (lead) {
        const convenors = otherActiveConvenors(groupId, lead);
        if (convenors.length > 0) return convenors;
    }
    return (db.prepare(`
        SELECT gm.member_pubkey FROM group_members gm JOIN members m ON m.public_key = gm.member_pubkey
        WHERE gm.group_id = ? AND gm.status = 'active' AND gm.role = 'member' AND m.status = 'active' AND m.is_visitor = 0
          AND (? IS NULL OR gm.member_pubkey != ?)
    `).all(groupId, lead, lead) as any[]).map(r => r.member_pubkey);
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
    no_longer_needed: 'the group has another lead convenor now',
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
    // The vote is about THIS lead. If the group has since handed the lead to someone else, or lost its last
    // convenor, the question no longer stands.
    if (getGroupLead(db, prop.group_id) !== prop.convenor_pubkey) {
        closeProposal(cb, prop, 'no_longer_needed');
        return 'no_longer_needed';
    }
    const electorate = successionElectorate(prop.group_id, prop.convenor_pubkey);
    if (!electorate.includes(prop.candidate_pubkey)) { closeProposal(cb, prop, 'candidate_gone'); return 'candidate_gone'; }

    const { yes, no } = tally(prop, electorate);
    const outstanding = Math.max(0, electorate.length - yes - no);
    const passes = final ? yes > no : yes > no + outstanding;
    const fails = final ? yes <= no : no >= yes + outstanding;
    if (passes) {
        // The outgoing lead keeps the convenor role when their fellow convenors voted — they lost the lead, not
        // the role (the enterprise rule: "old lead becomes ordinary keeper"). When the MEMBERS voted, the lead
        // was the group's only convenor and the group has just voted them out of running it: they become an
        // ordinary member, as they did before the lead convenor existed.
        const votedByConvenors = electorateKind(prop.group_id, prop.convenor_pubkey) === 'convenors';
        db.transaction(() => {
            db.prepare("UPDATE group_members SET role = ?, updated_at = ? WHERE group_id = ? AND member_pubkey = ?")
                .run(votedByConvenors ? 'convenor' : 'member', nowIso, prop.group_id, prop.convenor_pubkey);
            db.prepare("UPDATE group_members SET role = 'convenor', updated_at = ? WHERE group_id = ? AND member_pubkey = ?")
                .run(nowIso, prop.group_id, prop.candidate_pubkey);
            // The candidate is the group's lead from here on, written down, not inferred.
            db.prepare('UPDATE groups SET lead_pubkey = ?, updated_at = ? WHERE id = ?')
                .run(prop.candidate_pubkey, nowIso, prop.group_id);
            db.prepare("UPDATE group_convenor_proposals SET status = 'passed', executed_at = ? WHERE id = ?").run(nowIso, prop.id);
        })();
        postGroupSystemLine(cb, prop.group_id, GroupSystemType.CONVENOR_CHOSEN,
            `${votedByConvenors ? 'Convenors' : 'Members'} chose ${callsignOf(prop.candidate_pubkey)} as lead convenor (${yes} yes, ${no} no).`,
            { proposalId: prop.id, candidatePubkey: prop.candidate_pubkey, previousConvenorPubkey: prop.convenor_pubkey, yes, no });
        return 'passed';
    }
    if (fails) { closeProposal(cb, prop, 'rejected'); return 'rejected'; }
    return 'open';
}

function toInfo(r: any, viewer?: string): GroupSuccessionProposalInfo {
    const electorate = successionElectorate(r.group_id, r.convenor_pubkey);
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

const VOTE_ALREADY_OPEN = 'A vote on a new convenor is already open for this group';
const ALREADY_VOTED = 'You have already voted on this proposal';

/** SQLite's words for a lost insert race on a unique key: never shown to a member (PR #924 review, item 7). */
const isUniqueViolation = (e: any): boolean =>
    e?.code === 'SQLITE_CONSTRAINT_UNIQUE' || e?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || /UNIQUE constraint failed/.test(e?.message ?? '');

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
        throw new Error(VOTE_ALREADY_OPEN);
    }

    const silence = getConvenorSilence(groupId);
    if (!silence.convenorPubkey) throw new Error('Only a group with a lead convenor can choose a new one this way');
    if (!silence.isSilent) throw new Error('The convenor has been active on the node within the last 30 days');
    if (!silence.isEligible) throw new Error('Nobody else in this group can vote on its lead convenor');

    // Convenors when the lead has fellow convenors, members when the lead is the group's only convenor. Both the
    // proposer and the candidate come from that set, so the error says which one it is.
    const electorate = successionElectorate(groupId, silence.convenorPubkey);
    const voterWord = silence.electorate === 'convenors' ? 'convenor' : 'member';
    if (!electorate.includes(proposerPubkey)) throw new Error(`Only an active ${voterWord} of this group may propose a convenor`);
    if (candidatePubkey === silence.convenorPubkey) throw new Error('The candidate cannot be the current convenor');
    if (!electorate.includes(candidatePubkey)) throw new Error(`The candidate must be an active ${voterWord} of this group`);

    const id = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const deadlineAt = new Date(Date.now() + GROUP_SUCCESSION_WINDOW_MS).toISOString();
    try {
        db.transaction(() => {
            db.prepare(`
                INSERT INTO group_convenor_proposals (id, group_id, convenor_pubkey, candidate_pubkey, proposer_pubkey, status, created_at, deadline_at)
                VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
            `).run(id, groupId, silence.convenorPubkey, candidatePubkey, proposerPubkey, nowIso, deadlineAt);
            db.prepare("INSERT INTO group_convenor_votes (proposal_id, voter_pubkey, choice, voted_at) VALUES (?, ?, 'yes', ?)")
                .run(id, proposerPubkey, nowIso);
        })();
    } catch (e: any) {
        // Another proposal for this group landed between the check above and this insert: the partial unique
        // index on (group_id) WHERE status = 'active' refused ours. Same answer as the check (409 at the route).
        if (isUniqueViolation(e)) throw new Error(VOTE_ALREADY_OPEN);
        throw e;
    }

    const who = proposerPubkey === candidatePubkey
        ? `${callsignOf(proposerPubkey)} offered to be lead convenor`
        : `${callsignOf(proposerPubkey)} proposed ${callsignOf(candidatePubkey)} as lead convenor`;
    postGroupSystemLine(cb, groupId, GroupSystemType.CONVENOR_VOTE_OPENED,
        `${who}, because ${callsignOf(silence.convenorPubkey)} has not been active for 30 days. `
        + `${silence.electorate === 'convenors' ? 'The other convenors' : 'Members'} have 14 days to vote.`,
        { proposalId: id, candidatePubkey, proposerPubkey, deadlineAt, electorate: silence.electorate });

    const row = db.prepare('SELECT * FROM group_convenor_proposals WHERE id = ?').get(id) as any;
    const outcome = settle(cb, row, false, nowIso);

    // Tell the sitting convenor once (PR #924 review, item 3). "Silent" means no signed writes, so a convenor who
    // reads every day can still be the subject; one push gives them the chance to come back, which cancels the
    // vote. The normal chat push path, so their notify_chat preference applies — but not a mute of the group's
    // chat: like an @mention, a vote on their own role gets through. No names or text in the push.
    const groupName = (db.prepare('SELECT name FROM groups WHERE id = ?').get(groupId) as any)?.name ?? 'Your group';
    cb.dispatchPushNotification(
        [silence.convenorPubkey],
        proposerPubkey,
        `👥 ${groupName}`,
        outcome === 'passed'
            ? 'The group chose a new lead convenor while you were away'
            : 'The group opened a vote on a new lead convenor. Open the group to see it.',
        { screen: 'chat', conversationId: groupId, groupId },
        'chat',
    );
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

    if (!successionElectorate(prop.group_id, prop.convenor_pubkey).includes(voterPubkey)) {
        throw new Error('Only an active member of this group may vote on its convenor');
    }
    if (db.prepare('SELECT 1 FROM group_convenor_votes WHERE proposal_id = ? AND voter_pubkey = ?').get(proposalId, voterPubkey)) {
        throw new Error(ALREADY_VOTED);
    }
    try {
        db.prepare('INSERT INTO group_convenor_votes (proposal_id, voter_pubkey, choice, voted_at) VALUES (?, ?, ?, ?)')
            .run(proposalId, voterPubkey, choice, nowIso);
    } catch (e: any) {
        if (isUniqueViolation(e)) throw new Error(ALREADY_VOTED);
        throw e;
    }
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
        canPropose: silence.isEligible && !stillOpen && !!viewerPubkey
            && successionElectorate(groupId, silence.convenorPubkey).includes(viewerPubkey),
    };
}
