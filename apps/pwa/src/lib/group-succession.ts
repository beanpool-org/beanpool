/**
 * The quiet-lead vote, as a group's screen shows it (2026-09-23).
 *
 * A group's lead convenor cannot be removed or demoted by anyone, node admins included, so the group's only way
 * out of a lead who has gone quiet is the 30-day-silence vote. The rules are the server's
 * (apps/server/src/engine/group-succession.ts, whose header comment is the rulebook) and the server is the
 * authority on who may propose and who may vote: this module re-implements none of that. It turns the one
 * `GET /api/groups/:id/succession` answer into the handful of decisions a screen needs — show it at all, offer
 * the picker, offer Yes/No — reading `silence`, `proposals` and `canPropose` and nothing else.
 *
 * Pure functions only, so the words and the hiding are tested; the native app carries the same file.
 */

import { timeLeftText } from './keeper-governance';
import { formatDate, t, tn } from '@beanpool/core';
import type { GroupMember } from './api';

export type GroupSuccessionClosedReason = 'rejected' | 'convenor_returned' | 'candidate_gone' | 'candidate_ineligible' | 'no_longer_needed';

/** The lead the vote is about, and whether one can open at all. Straight from the server. */
export interface GroupSilence {
    /** The group's LEAD convenor, under the server's own field name, or null when the group has no convenor. */
    convenorPubkey: string | null;
    convenorCallsign: string | null;
    lastActiveAt: string | null;
    daysInactive: number;
    isSilent: boolean;
    /**
     * Silent AND somebody is left who may vote. Nothing shows unless this is true, a vote is running, or one
     * closed within the last fortnight.
     */
    isEligible: boolean;
    /**
     * Who votes: the lead's other convenors, or the members when none of the other convenors was made a convenor by
     * the day the lead was last active (`votersJoinedBy`; on a node older than that rule, when the lead is the only
     * convenor).
     */
    electorate: 'convenors' | 'members';
    /**
     * Only people in the group by this UTC day (its midnight, ISO) take part — for the convenors' vote, people who
     * were convenors by then: the day the lead was last active (2026-09-28). Absent from a node older than that rule.
     */
    votersJoinedBy?: string | null;
}

/**
 * One proposal. Ballots are secret: the server sends totals and the viewer's own vote, and never a voter list —
 * so there is no voter identity here to render by accident.
 */
export interface GroupSuccessionProposal {
    id: string;
    groupId: string;
    convenorPubkey: string;
    convenorCallsign: string | null;
    candidatePubkey: string;
    candidateCallsign: string | null;
    proposerPubkey: string;
    proposerCallsign: string | null;
    status: 'active' | 'passed' | 'cancelled';
    closedReason: GroupSuccessionClosedReason | null;
    createdAt: string;
    deadlineAt: string;
    executedAt: string | null;
    yesCount: number;
    noCount: number;
    electorateSize: number;
    /** The viewer's own vote, never anyone else's. */
    myVote: 'yes' | 'no' | null;
    canVote: boolean;
}

export interface GroupSuccessionData {
    silence: GroupSilence;
    proposals: GroupSuccessionProposal[];
    canPropose: boolean;
    /** Who may propose, stand and vote right now, while the lead is silent. Absent from a node older than the rule. */
    voters?: string[];
}

export interface GroupSuccessionView {
    /**
     * Draw the section at all. A healthy group sees nothing new, and a node too old for the route answers 404,
     * which reaches here as `null` data and hides it just as quietly.
     */
    show: boolean;
    /** The vote that is running, or null. */
    openProposal: GroupSuccessionProposal | null;
    /**
     * "<lead> hasn't been active for 34 days. The group can choose a new lead." — or, when nobody who may vote is left,
     * why no vote can open.
     */
    silenceLine: string | null;
    /**
     * "Only the members who were in the group by 19 Aug 2026 vote; convenors appointed after 19 Aug 2026 don't."
     * Who takes part, while a vote can run or is running.
     */
    whoVotesLine: string | null;
    /** Offer the Propose action and its picker. False unless the SERVER says this viewer may propose. */
    canPropose: boolean;
    /** Who the picker offers, in roster order, the viewer included. */
    candidates: GroupMember[];
    /** Offer Yes/No. False unless the SERVER says this viewer may still vote. */
    canVote: boolean;
    /** The viewer's own vote, once cast. */
    myVote: 'yes' | 'no' | null;
    /** "2 yes, 1 no, of 5 who can vote." */
    tallyLine: string | null;
    /** "Closes 7 Oct 2026 — 13 days left." */
    closingLine: string | null;
    /** The latest closed vote in one line, when none is running. */
    outcomeLine: string | null;
    /**
     * Nothing is under way: the lead is active again, no vote is running, and all that is left to say is how the
     * last one ended. The screen draws that single line plainly — no warning colour, and no heading claiming a
     * process that is over.
     */
    outcomeOnly: boolean;
}

/** A date anyone reads the same way, in any locale: "7 Oct 2026". */
export function closingDateText(iso: string): string | null {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return formatDate(d, 'day-month-year', { utc: true });
}

/** "Closes 7 Oct 2026 — 13 days left." The deadline is the server's; the countdown is only a kindness. */
export function closingLineText(p: GroupSuccessionProposal, now = Date.now()): string | null {
    const date = p.deadlineAt ? closingDateText(p.deadlineAt) : null;
    if (!date) return null;
    return t('Closes {date} — {time}.', { date, time: timeLeftText(p.deadlineAt, now) });
}

export function tallyLineText(p: GroupSuccessionProposal): string {
    const can = p.electorateSize ?? 0;
    return tn(can, '{yes} yes, {no} no, of {n} who can vote.', '{yes} yes, {no} no, of {n} who can vote.', { yes: p.yesCount, no: p.noCount });
}

/**
 * Who takes part, in the server's own terms: "members who were in the group by 19 Aug 2026", or "convenors appointed
 * by …" when the convenors vote. Null from a node older than the rule, which sends no day.
 */
export function electorateText(s: GroupSilence): string | null {
    const by = s.votersJoinedBy ? closingDateText(s.votersJoinedBy) : null;
    if (!by) return null;
    return s.electorate === 'convenors' ? `convenors appointed by ${by}` : `members who were in the group by ${by}`;
}

/** "Only the members who were in the group by 19 Aug 2026 vote; convenors appointed after 19 Aug 2026 don't." */
export function whoVotesLineText(s: GroupSilence): string | null {
    const by = s.votersJoinedBy ? closingDateText(s.votersJoinedBy) : null;
    if (!by) return null;
    return s.electorate === 'convenors'
        ? t('Only convenors appointed by {date} can vote.', { date: by })
        : t("Only the members who were in the group by {date} vote; convenors appointed after {date} don't.", { date: by });
}

/**
 * The lead is quiet, but nobody who may vote is left — everyone came after the lead went quiet. No vote can ever
 * open, so the group is told why rather than shown nothing (or a button that is refused).
 */
export function nobodyCanVote(s: GroupSilence): boolean {
    return !!s.convenorPubkey && s.isSilent && !s.isEligible && electorateText(s) !== null;
}

/** Why the lead can be replaced, in the group's own words — or why, although quiet, they can't be. */
export function silenceLineText(s: GroupSilence): string | null {
    // The lead's name as written; with none, each sentence names "the lead convenor" itself.
    const name = s.convenorCallsign;
    const days = Math.floor(s.daysInactive);
    if (nobodyCanVote(s)) {
        // In a members' vote every convenor but the lead was appointed after the day (had one been appointed by then,
        // the convenors would be voting), so the line says why they can't either, as whoVotesLineText does.
        const date = closingDateText(s.votersJoinedBy as string) ?? '';
        if (s.electorate === 'convenors') {
            return name
                ? tn(days, "{name} hasn't been active for {n} day. Only convenors appointed by {date} can choose a new lead, and there are none, so no vote can open.", "{name} hasn't been active for {n} days. Only convenors appointed by {date} can choose a new lead, and there are none, so no vote can open.", { name, date })
                : tn(days, "The lead convenor hasn't been active for {n} day. Only convenors appointed by {date} can choose a new lead, and there are none, so no vote can open.", "The lead convenor hasn't been active for {n} days. Only convenors appointed by {date} can choose a new lead, and there are none, so no vote can open.", { date });
        }
        return name
            ? tn(days, "{name} hasn't been active for {n} day. Only the members who were in the group by {date} can choose a new lead, and there are none (convenors appointed after {date} can't), so no vote can open.", "{name} hasn't been active for {n} days. Only the members who were in the group by {date} can choose a new lead, and there are none (convenors appointed after {date} can't), so no vote can open.", { name, date })
            : tn(days, "The lead convenor hasn't been active for {n} day. Only the members who were in the group by {date} can choose a new lead, and there are none (convenors appointed after {date} can't), so no vote can open.", "The lead convenor hasn't been active for {n} days. Only the members who were in the group by {date} can choose a new lead, and there are none (convenors appointed after {date} can't), so no vote can open.", { date });
    }
    if (!s.isEligible) return null;
    return name
        ? tn(days, "{name} hasn't been active for {n} day. The group can choose a new lead.", "{name} hasn't been active for {n} days. The group can choose a new lead.", { name })
        : tn(days, "The lead convenor hasn't been active for {n} day. The group can choose a new lead.", "The lead convenor hasn't been active for {n} days. The group can choose a new lead.");
}

/**
 * How long a finished vote stays on the group's screen (decided on PR #1062, 2026-09-23). A result is news for a
 * fortnight; after that a group whose lead is active again is simply a healthy group, and a healthy group sees
 * nothing here.
 */
export const OUTCOME_VISIBLE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * When a finished vote finished, in ms, or null if that cannot be said.
 *
 * The server writes `executed_at` only for a vote that PASSED; one that was rejected or cancelled is written with
 * a status and a reason and no timestamp at all (apps/server/src/engine/group-succession.ts, `closeProposal`), so
 * there is nothing else to read for those. `deadlineAt` is the honest stand-in: a vote can only close at or
 * before its own deadline, which makes it the latest moment the vote could still have been live. It therefore
 * never drops an outcome while it is still fresh, and at worst keeps one a little past its fortnight — by less
 * than the 14 days a vote runs.
 */
export function proposalClosedAtMs(p: GroupSuccessionProposal | null | undefined): number | null {
    if (!p || p.status === 'active') return null;
    const when = p.executedAt || p.deadlineAt;
    const ms = when ? Date.parse(when) : NaN;
    return Number.isNaN(ms) ? null : ms;
}

/** Is this finished vote still recent enough to be worth a line? */
export function isOutcomeRecent(p: GroupSuccessionProposal | null | undefined, now = Date.now()): boolean {
    const closedAt = proposalClosedAtMs(p);
    return closedAt !== null && now - closedAt < OUTCOME_VISIBLE_MS;
}

/** The latest finished vote, in one line for the fortnight after it closed. No history list: decision 5. */
export function outcomeLineText(p: GroupSuccessionProposal | null | undefined): string | null {
    if (!p || p.status === 'active') return null;
    // Names as written; with none, each sentence names "the person proposed" or "the lead" itself.
    const name = p.candidateCallsign;
    const lead = p.convenorCallsign;
    if (p.status === 'passed') return name ? t("{name} is now the group's lead convenor.", { name }) : t("The person proposed is now the group's lead convenor.");
    switch (p.closedReason) {
        case 'rejected':
            return lead ? t('The group voted no, so {name} is still the lead.', { name: lead }) : t('The group voted no, so the lead is still the lead.');
        case 'convenor_returned':
            return lead ? t('{name} came back, so the vote closed.', { name: lead }) : t('The lead came back, so the vote closed.');
        case 'candidate_gone':
            return name ? t('{name} is no longer in the group, so the vote closed.', { name }) : t('The person proposed is no longer in the group, so the vote closed.');
        case 'candidate_ineligible':
            return name ? t("{name} can't be chosen as lead, so the vote closed.", { name }) : t("The person proposed can't be chosen as lead, so the vote closed.");
        case 'no_longer_needed':
            return t('The group has another lead now, so the vote closed.');
        default:
            return t('The last vote on a new lead closed.');
    }
}

/**
 * Who the picker offers. The server decides eligibility on every write; the field it publishes for the screen is
 * `silence.electorate`, and this reads that rather than working out a rule of its own. The viewer is in the list
 * on purpose — proposing yourself is allowed — and a refusal from the server is still what has the last word.
 */
export function proposalCandidates(silence: GroupSilence, members: GroupMember[], voters?: string[]): GroupMember[] {
    const lead = silence.convenorPubkey;
    const wanted = silence.electorate === 'convenors' ? 'convenor' : 'member';
    // A node with the "there before the lead went quiet" rule names who may stand: offer exactly them, never someone
    // who joined (or was made a convenor) since and would only be refused.
    const eligible = Array.isArray(voters) ? new Set(voters) : null;
    return members.filter(m => m.status === 'active' && m.role === wanted && m.memberPubkey !== lead
        && (!eligible || eligible.has(m.memberPubkey)));
}

/**
 * Everything the screen needs, from the one answer plus the roster it already holds.
 *
 * `data` is null when the route is missing (an older node) or the read failed: the section hides, because there
 * is nothing true to say.
 */
export function buildSuccessionView(
    data: GroupSuccessionData | null | undefined,
    members: GroupMember[] = [],
    now = Date.now(),
): GroupSuccessionView {
    const hidden: GroupSuccessionView = {
        show: false, openProposal: null, silenceLine: null, whoVotesLine: null, canPropose: false, candidates: [],
        canVote: false, myVote: null, tallyLine: null, closingLine: null, outcomeLine: null, outcomeOnly: false,
    };
    if (!data || !data.silence) return hidden;

    const proposals = Array.isArray(data.proposals) ? data.proposals : [];
    const openProposal = proposals.find(p => p.status === 'active') ?? null;
    // Proposals come back newest first (the server orders by created_at DESC), so the latest closed one is simply
    // the first that is not the open one.
    const latestClosed = proposals.find(p => p.status !== 'active') ?? null;

    // Decision 2: nothing at all for a healthy group. The section exists while the lead can be replaced, while a
    // vote is running, and for a fortnight after one closed — long enough for the group to learn what happened,
    // and not a day longer. A group that settled the question a year ago sees no card at all.
    // A quiet lead nobody may vote on — everyone in the group came after they went quiet — is said out loud, so
    // nobody is left wondering why there is nothing to press. Not to a lead alone in their group: there is nobody
    // else to tell.
    const lead = data.silence.convenorPubkey;
    const nobody = !openProposal && nobodyCanVote(data.silence)
        && members.some(m => m.status === 'active' && m.memberPubkey !== lead);
    if (!data.silence.isEligible && !openProposal && !nobody && !isOutcomeRecent(latestClosed, now)) return hidden;

    // The whole section is one closed vote's outcome: the lead is active, nothing is running, and there is
    // nothing to offer — the server would refuse a proposal for a lead who is not silent.
    const outcomeOnly = !data.silence.isEligible && !openProposal && !nobody;

    return {
        show: true,
        openProposal,
        silenceLine: silenceLineText(data.silence),
        whoVotesLine: outcomeOnly || nobody ? null : whoVotesLineText(data.silence),
        // Both halves of this are the server's: `canPropose` already goes false while a vote is open, and the
        // second only makes that impossible to get wrong on a stale read.
        canPropose: !!data.canPropose && !openProposal && !outcomeOnly,
        candidates: proposalCandidates(data.silence, members, data.voters),
        canVote: !!openProposal?.canVote,
        myVote: openProposal?.myVote ?? null,
        tallyLine: openProposal ? tallyLineText(openProposal) : null,
        closingLine: openProposal ? closingLineText(openProposal, now) : null,
        // The fortnight gates the LINE as well as the section. While the lead is eligible again the section
        // exists for that reason alone, and a year-old outcome printed undated under the amber heading would
        // read as current and contradict it ("Marty hasn't been active for 44 days." / "Marty came back, so
        // the vote closed.").
        outcomeLine: openProposal || !isOutcomeRecent(latestClosed, now) ? null : outcomeLineText(latestClosed),
        outcomeOnly,
    };
}

/** The confirm a voter reads before their one and only vote. */
export function voteConfirmText(choice: 'yes' | 'no', candidateCallsign: string | null | undefined): string {
    const name = candidateCallsign;
    if (choice === 'yes') {
        return name
            ? t("Vote yes to make {name} the group's lead convenor? Votes can't be changed.", { name })
            : t("Vote yes to make this member the group's lead convenor? Votes can't be changed.");
    }
    return name
        ? t("Vote no to making {name} the group's lead convenor? Votes can't be changed.", { name })
        : t("Vote no to making this member the group's lead convenor? Votes can't be changed.");
}
