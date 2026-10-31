import React, { useEffect, useState } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import {
    fetchAdminDecisions, fetchNodeDecisionsOn, fetchPastRemovalVotes, haltDecision, hideDecisionCase, ownerDecideRemoval, takeDownDecisionReply,
    type AdminDecisionItem,
} from '../../lib/node-client';
import { FreshProofBox, useFreshProof } from '../common/FreshProofBox';
import { ModalBackdrop } from '../common/ModalBackdrop';
import { nodeCredential } from '../../lib/profiles';
import type { RolesViewer } from './NodeRolesPanel';

interface DecisionsAdminPanelProps {
    activeNode: NodeProfile;
    tfaToken?: string;
    /** Who is looking: owner level alone is offered an owner's decision (the node refuses anyone else). */
    viewer?: RolesViewer;
}

/** The node demands at least this many characters; the reason is public on the Decision. */
export const MIN_HALT_REASON = 10;

function formatDate(iso: string | null | undefined): string {
    if (!iso) return '';
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t).toLocaleDateString() : '';
}

/**
 * A pause's own vote (removal by vote S2): the community's vote on removing a member, which the node opened when an
 * admin paused them (its author is the node, its params carry `rule: 2`). Halting it while it is open lifts the pause,
 * as halting a "Keep …'s suspension?" vote does (apps/server decisions-engine.ts isPauseVote and adminHaltDecision).
 */
function isPauseVote(d: AdminDecisionItem): boolean {
    return d.effect === 'remove_member' && d.authorPubkey === 'SYSTEM' && d.params?.rule === 2;
}

/**
 * An emergency suspension nobody votes on: one made while formal Decisions were off (`params.noVote`), or any one on a
 * node where they are off now, a pause's own vote included. Either way it lifts by itself at `closesAt`, whatever votes
 * it holds, and halting it lifts it now (apps/server decisions-engine.ts, madeWithoutVote and executeDecision).
 */
function isNoVoteSuspension(d: AdminDecisionItem, decisionsOn: boolean): boolean {
    return (d.effect === 'keep_suspension' && (!decisionsOn || d.params?.noVote === true)) || (!decisionsOn && d.status === 'open' && isPauseVote(d));
}

function suspendedName(d: AdminDecisionItem): string {
    const memberName = d.params?.memberName;
    return d.subjectName || (typeof memberName === 'string' && memberName) || 'A member';
}

/**
 * A vote on removing a member, whose case an admin can hide as shown to be false (removal by vote, Amendment A point 4):
 * members then read the admin's reason in its place. Not a suspension nobody votes on.
 */
function hasCase(d: AdminDecisionItem, decisionsOn: boolean): boolean {
    return d.effect === 'remove_member' && !isNoVoteSuspension(d, decisionsOn);
}

/** A removal vote's case: hidden, with the reason members read, or the button that hides it. */
function CaseControl({ d, onHide }: { d: AdminDecisionItem; onHide: (d: AdminDecisionItem) => void }) {
    if (d.caseHiddenAt) {
        return (
            <p className="text-xs text-amber-300 m-0 break-words" data-testid="admin-case-hidden">
                Case hidden as false. Members read: “{d.caseHiddenReason}”
            </p>
        );
    }
    return (
        <button
            onClick={() => onHide(d)}
            className="px-3 py-2 rounded-lg bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700"
        >
            Hide case
        </button>
    );
}

/**
 * A removal vote's reply from the member: taken down, with the reason members read, or the button that takes it down; none
 * until they write one.
 */
function ReplyControl({ d, onTakeDown }: { d: AdminDecisionItem; onTakeDown: (d: AdminDecisionItem) => void }) {
    if (d.replyHiddenAt) {
        return (
            <p className="text-xs text-amber-300 m-0 break-words" data-testid="admin-reply-taken-down">
                Reply taken down. Members read: “{d.replyHiddenReason}”
            </p>
        );
    }
    if (!d.subjectReply) return null;
    return (
        <button
            onClick={() => onTakeDown(d)}
            className="px-3 py-2 rounded-lg bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700"
        >
            Take down reply
        </button>
    );
}

/**
 * An open pause's vote that too few members can vote on (removal by vote S6, design §5 point 3): fewer than 3 others could
 * vote, so its quorum can't be met, and an owner may decide it. Not a vote on someone who holds a server role: no vote, and
 * no owner's decision, removes an owner or admin.
 */
function ownerMayDecide(d: AdminDecisionItem): boolean {
    return d.status === 'open' && isPauseVote(d) && d.tally?.tooFewToVote === true && !d.ownerDecidedAt && !d.params?.serverRole;
}

/**
 * An owner's decision on a vote too few could vote on, as members read it, or the button that makes one (owners only). A
 * hidden case takes the owner's reason from what members read (it may repeat the accusation); this list keeps it.
 */
function OwnerDecisionControl({ d, isOwner, onDecide }: { d: AdminDecisionItem; isOwner: boolean; onDecide: (d: AdminDecisionItem) => void }) {
    if (d.ownerDecidedAt) {
        const reason = d.caseHiddenAt ? `Hidden from members with the case: “${d.ownerDecidedReason}”` : `Members read: “${d.ownerDecidedReason}”`;
        return (
            <p className="text-xs text-amber-300 m-0 break-words" data-testid="admin-owner-decided">
                {d.ownerDecisionCarriedAt
                    ? `Decided by the owner: too few members to vote. ${reason}`
                    : `An owner decided: carried out when the vote closes, if still fewer than 3 could vote. ${reason}`}
            </p>
        );
    }
    if (!isOwner || !ownerMayDecide(d)) return null;
    return (
        <button
            onClick={() => onDecide(d)}
            className="px-3 py-2 rounded-lg bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700"
        >
            Decide as owner
        </button>
    );
}

/**
 * Community Decisions an admin can still act on — open votes and removals in their 7-day grace window —
 * with the admin brake: halt, with a written reason members will see. Totals only; the node never serves
 * who voted how. An emergency suspension nobody votes on (the global node) shows as a suspension with its
 * end date, and the brake as lifting it now. A vote on removing a member, open or closed, can have its case hidden as
 * one shown to be false, with a reason members read in its place (removal by vote, Amendment A point 4), and the member's
 * reply taken down when it harms someone else, the same way. A pause's vote too few members can vote on can be decided by an
 * owner, with the fresh proof and a reason members read (removal by vote S6).
 */
export function DecisionsAdminPanel({ activeNode, tfaToken, viewer = { kind: 'password' } }: DecisionsAdminPanelProps) {
    const isOwner = viewer.kind === 'password' || viewer.role === 'owner';
    const [decisions, setDecisions] = useState<AdminDecisionItem[]>([]);
    const [decisionsOn, setDecisionsOn] = useState(true);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [haltTarget, setHaltTarget] = useState<AdminDecisionItem | null>(null);
    const [reason, setReason] = useState('');
    const [halting, setHalting] = useState(false);
    const [haltError, setHaltError] = useState<string | null>(null);
    // Closed votes on removing a member, whose case can still be hidden (removal by vote, Amendment A point 4).
    const [pastRemovals, setPastRemovals] = useState<AdminDecisionItem[]>([]);
    const [hideTarget, setHideTarget] = useState<AdminDecisionItem | null>(null);
    const [hideReason, setHideReason] = useState('');
    const [hiding, setHiding] = useState(false);
    const [hideError, setHideError] = useState<string | null>(null);
    // A member's reply taken down, open vote or closed.
    const [takeDownTarget, setTakeDownTarget] = useState<AdminDecisionItem | null>(null);
    const [takeDownReason, setTakeDownReason] = useState('');
    const [takingDown, setTakingDown] = useState(false);
    const [takeDownError, setTakeDownError] = useState<string | null>(null);
    // An owner deciding a vote too few members can vote on (removal by vote S6).
    const [decideTarget, setDecideTarget] = useState<AdminDecisionItem | null>(null);
    const [decideReason, setDecideReason] = useState('');
    const [deciding, setDeciding] = useState(false);
    const [decideError, setDecideError] = useState<string | null>(null);
    const proof = useFreshProof();

    const load = async () => {
        if (!activeNode?.url) return;
        setLoading(true);
        setError(null);
        try {
            const [list, on, past] = await Promise.all([
                fetchAdminDecisions(activeNode.url, nodeCredential(activeNode), tfaToken),
                fetchNodeDecisionsOn(activeNode.url),
                // A node from before has none; one that can't say keeps the open list showing.
                fetchPastRemovalVotes(activeNode.url, nodeCredential(activeNode), tfaToken).catch(() => [] as AdminDecisionItem[]),
            ]);
            setDecisions(list);
            setDecisionsOn(on);
            setPastRemovals(past);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Failed to load Decisions');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
    }, [activeNode?.id, activeNode?.url]);

    const closeModal = () => {
        if (halting) return;
        setHaltTarget(null);
        setReason('');
        setHaltError(null);
    };

    const trimmed = reason.trim();
    const reasonOk = trimmed.length >= MIN_HALT_REASON;
    const haltIsLift = !!haltTarget && isNoVoteSuspension(haltTarget, decisionsOn);
    // With formal Decisions off, a list of nothing but suspensions is headed as what it is.
    const suspensionsOnly = !decisionsOn && decisions.every((d) => isNoVoteSuspension(d, decisionsOn));

    const hideTrimmed = hideReason.trim();
    const hideReasonOk = hideTrimmed.length >= MIN_HALT_REASON;
    const openHide = (d: AdminDecisionItem) => { setHideTarget(d); setHideReason(''); setHideError(null); };
    const closeHide = () => {
        if (hiding) return;
        setHideTarget(null);
        setHideReason('');
        setHideError(null);
    };
    const confirmHide = async () => {
        if (!hideTarget || !hideReasonOk) return;
        setHiding(true);
        setHideError(null);
        try {
            await hideDecisionCase(activeNode.url, hideTarget.id, hideTrimmed, nodeCredential(activeNode), tfaToken);
            setHideTarget(null);
            setHideReason('');
            await load();
        } catch (err: unknown) {
            setHideError(err instanceof Error ? err.message : 'Failed to hide the case');
        } finally {
            setHiding(false);
        }
    };

    const takeDownTrimmed = takeDownReason.trim();
    const takeDownReasonOk = takeDownTrimmed.length >= MIN_HALT_REASON;
    const openTakeDown = (d: AdminDecisionItem) => { setTakeDownTarget(d); setTakeDownReason(''); setTakeDownError(null); };
    const closeTakeDown = () => {
        if (takingDown) return;
        setTakeDownTarget(null);
        setTakeDownReason('');
        setTakeDownError(null);
    };
    const confirmTakeDown = async () => {
        if (!takeDownTarget || !takeDownReasonOk) return;
        setTakingDown(true);
        setTakeDownError(null);
        try {
            await takeDownDecisionReply(activeNode.url, takeDownTarget.id, takeDownTrimmed, nodeCredential(activeNode), tfaToken);
            setTakeDownTarget(null);
            setTakeDownReason('');
            await load();
        } catch (err: unknown) {
            setTakeDownError(err instanceof Error ? err.message : 'Failed to take down the reply');
        } finally {
            setTakingDown(false);
        }
    };

    const decideTrimmed = decideReason.trim();
    const decideReasonOk = decideTrimmed.length >= MIN_HALT_REASON;
    const openDecide = (d: AdminDecisionItem) => { setDecideTarget(d); setDecideReason(''); setDecideError(null); proof.close(); };
    const closeDecide = () => {
        if (deciding) return;
        setDecideTarget(null);
        setDecideReason('');
        setDecideError(null);
        proof.close();
    };
    const confirmDecide = async (code?: string) => {
        if (!decideTarget || !decideReasonOk) return;
        setDeciding(true);
        setDecideError(null);
        try {
            await ownerDecideRemoval(activeNode.url, decideTarget.id, decideTrimmed, nodeCredential(activeNode), tfaToken, code);
            proof.close();
            setDecideTarget(null);
            setDecideReason('');
            await load();
        } catch (err: unknown) {
            if (proof.checkError(err, (c) => confirmDecide(c), code)) return;
            setDecideError(err instanceof Error ? err.message : 'Failed to decide the vote');
        } finally {
            setDeciding(false);
        }
    };

    const confirmHalt = async () => {
        if (!haltTarget || !reasonOk) return;
        setHalting(true);
        setHaltError(null);
        try {
            await haltDecision(activeNode.url, haltTarget.id, trimmed, nodeCredential(activeNode), tfaToken);
            setHaltTarget(null);
            setReason('');
            await load();
        } catch (err: unknown) {
            setHaltError(err instanceof Error ? err.message : haltIsLift ? 'Failed to lift the suspension' : 'Failed to halt the Decision');
        } finally {
            setHalting(false);
        }
    };

    return (
        <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4">
            <div className="flex flex-wrap lg:flex-nowrap items-center justify-between gap-3 lg:gap-0">
                <div className="min-w-0">
                    <h3 className="text-base font-bold text-white m-0">
                        {suspensionsOnly ? `Suspensions (${decisions.length})` : `Community Decisions (${decisions.length})`}
                    </h3>
                    <p className="text-xs text-nature-400 m-0 mt-0.5">
                        {suspensionsOnly
                            ? 'Votes are off on this node, so a suspension lifts by itself after 7 days. Lifting one ends it now; your reason is shown to members.'
                            : 'Open votes and removals waiting out their 7 days. Halting stops one; your reason is shown to members.'}
                    </p>
                </div>
                <button
                    onClick={load}
                    disabled={loading}
                    className="px-3 py-1.5 rounded-lg bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 disabled:opacity-50"
                >
                    {loading ? 'Loading…' : 'Refresh'}
                </button>
            </div>

            {error && <div className="p-3 rounded-xl bg-red-950/60 border border-red-800 text-xs text-red-300">{error}</div>}

            {loading && decisions.length === 0 && (
                <div className="py-6 text-center text-xs text-nature-400 flex items-center justify-center gap-2">
                    <span className="animate-spin text-bp-ink-terra" aria-hidden="true">⏳</span>
                    <span>Loading Community Decisions...</span>
                </div>
            )}

            {!error && decisions.length === 0 && !loading && (
                <div className="py-6 text-center text-xs text-nature-400">{suspensionsOnly ? 'No suspensions.' : 'No open Decisions.'}</div>
            )}

            <div className="space-y-3">
                {decisions.map((d) => {
                    if (isNoVoteSuspension(d, decisionsOn)) {
                        return (
                            <div key={d.id} className="p-4 rounded-xl bg-nature-950 border border-nature-800 space-y-2" data-testid="admin-decision-row">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-nature-800 text-nature-300">
                                        Suspension
                                    </span>
                                    <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-amber-900/40 text-amber-300">
                                        {`Suspended until ${formatDate(d.closesAt)}`}
                                    </span>
                                </div>
                                <h4 className="text-sm font-bold text-white m-0 break-words">{suspendedName(d)} is suspended</h4>
                                <p className="text-xs text-nature-300 m-0">No vote. It lifts by itself on that day, or sooner if you lift it.</p>
                                <div className="flex justify-end">
                                    <button
                                        onClick={() => { setHaltTarget(d); setReason(''); setHaltError(null); }}
                                        className="px-3 py-2 rounded-lg bg-bp-chip-danger-tint hover:opacity-90 text-xs font-bold text-bp-chip-danger-ink border border-red-800"
                                    >
                                        Lift suspension now
                                    </button>
                                </div>
                            </div>
                        );
                    }
                    const isKeep = d.effect === 'keep_suspension';
                    const inGrace = d.status === 'execution_pending_grace';
                    return (
                        <div key={d.id} className="p-4 rounded-xl bg-nature-950 border border-nature-800 space-y-2" data-testid="admin-decision-row">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-nature-800 text-nature-300">
                                    {isKeep ? 'Keep suspension?' : d.effect.replace(/_/g, ' ')}
                                </span>
                                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-amber-900/40 text-amber-300">
                                    {inGrace ? `Removal on ${formatDate(d.gracePeriodEndsAt)}` : `Closes ${formatDate(d.closesAt)}`}
                                </span>
                            </div>
                            <h4 className="text-sm font-bold text-white m-0">{d.title}</h4>
                            {d.subjectName && <p className="text-xs text-nature-400 m-0">About: {d.subjectName}</p>}
                            <p className="text-xs text-nature-300 m-0">
                                {d.tally.totalVoters} of {d.tally.quorumRequired} votes needed · Yes {d.tally.yesWeight} · No {d.tally.noWeight}
                            </p>
                            {ownerMayDecide(d) && (
                                <p className="text-xs text-amber-300 m-0" data-testid="admin-too-few-to-vote">
                                    Fewer than 3 members could vote. If nobody else votes, an owner decides: left alone, the pause lifts when the vote closes.
                                </p>
                            )}
                            <div className="flex flex-wrap items-center justify-end gap-2">
                                {hasCase(d, decisionsOn) && <CaseControl d={d} onHide={openHide} />}
                                {hasCase(d, decisionsOn) && <ReplyControl d={d} onTakeDown={openTakeDown} />}
                                {hasCase(d, decisionsOn) && <OwnerDecisionControl d={d} isOwner={isOwner} onDecide={openDecide} />}
                                <button
                                    onClick={() => { setHaltTarget(d); setReason(''); setHaltError(null); }}
                                    className="px-3 py-2 rounded-lg bg-bp-chip-danger-tint hover:opacity-90 text-xs font-bold text-bp-chip-danger-ink border border-red-800"
                                >
                                    Halt this Decision
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>

            {pastRemovals.length > 0 && (
                <div className="space-y-3 pt-2" data-testid="past-removal-votes">
                    <div>
                        <h4 className="text-sm font-bold text-white m-0">Closed votes on removing a member ({pastRemovals.length})</h4>
                        <p className="text-xs text-nature-400 m-0 mt-0.5">
                            A case shown to be false can be hidden, and a reply that harms someone taken down: members read your reason in its place.
                        </p>
                    </div>
                    {pastRemovals.map((d) => (
                        <div key={d.id} className="p-4 rounded-xl bg-nature-950 border border-nature-800 space-y-2" data-testid="past-removal-row">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-nature-800 text-nature-300">
                                    {d.status.replace(/_/g, ' ')}
                                </span>
                                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-nature-800 text-nature-300">
                                    {`Closed ${formatDate(d.closesAt)}`}
                                </span>
                            </div>
                            <h4 className="text-sm font-bold text-white m-0 break-words">{d.title}</h4>
                            {d.subjectName && <p className="text-xs text-nature-400 m-0">About: {d.subjectName}</p>}
                            {d.ownerDecisionCarriedAt && <OwnerDecisionControl d={d} isOwner={isOwner} onDecide={openDecide} />}
                            <div className="flex flex-wrap items-center justify-end gap-2">
                                <CaseControl d={d} onHide={openHide} />
                                <ReplyControl d={d} onTakeDown={openTakeDown} />
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {hideTarget && (
                <ModalBackdrop onClose={closeHide} dismissable={!hiding} className="fixed inset-0 overflow-y-auto bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Hide case">
                    <div className="m-auto w-full max-w-md bg-nature-900 border border-nature-800 rounded-3xl p-6 shadow-2xl space-y-3">
                        <h3 className="text-base font-bold text-white m-0 break-words">Hide the case of “{hideTarget.title}”?</h3>
                        <p className="text-xs text-nature-400 m-0">
                            For a case shown to be false. Members stop reading the case and read your reason in its place; who brought it
                            and the member's reply stay. The vote itself carries on: to stop it, halt it.
                        </p>
                        <label className="block text-xs font-bold text-nature-300" htmlFor="hide-case-reason">
                            Reason (members will see this)
                        </label>
                        <textarea
                            id="hide-case-reason"
                            value={hideReason}
                            onChange={(e) => setHideReason(e.target.value)}
                            rows={3}
                            className="w-full rounded-xl bg-nature-950 border border-nature-700 text-sm text-white p-2"
                            placeholder="How the case was shown to be false"
                        />
                        <p className={`text-[11px] m-0 ${hideReasonOk ? 'text-nature-500' : 'text-amber-400'}`}>
                            {hideReasonOk ? `${hideTrimmed.length} characters` : `At least ${MIN_HALT_REASON} characters (${hideTrimmed.length} so far)`}
                        </p>
                        {hideError && <div className="p-2 rounded-lg bg-red-950/60 border border-red-800 text-xs text-red-300">{hideError}</div>}
                        <div className="flex justify-end gap-2 pt-1">
                            <button onClick={closeHide} disabled={hiding} className="px-3 py-2 rounded-lg bg-nature-800 hover:bg-nature-700 text-xs font-semibold text-white">
                                Cancel
                            </button>
                            <button
                                onClick={confirmHide}
                                disabled={!hideReasonOk || hiding}
                                className="px-3 py-2 rounded-lg bg-bp-danger-fill hover:bg-bp-danger-hover text-xs font-bold text-bp-danger-on disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {hiding ? 'Hiding…' : 'Hide case'}
                            </button>
                        </div>
                    </div>
                </ModalBackdrop>
            )}

            {takeDownTarget && (
                <ModalBackdrop onClose={closeTakeDown} dismissable={!takingDown} className="fixed inset-0 overflow-y-auto bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Take down reply">
                    <div className="m-auto w-full max-w-md bg-nature-900 border border-nature-800 rounded-3xl p-6 shadow-2xl space-y-3">
                        <h3 className="text-base font-bold text-white m-0 break-words">Take down {suspendedName(takeDownTarget)}'s reply?</h3>
                        <blockquote className="m-0 p-3 rounded-xl bg-nature-950 border border-nature-800 text-xs text-nature-200 whitespace-pre-wrap break-words" data-testid="take-down-reply-text">
                            {takeDownTarget.subjectReply}
                        </blockquote>
                        <p className="text-xs text-nature-400 m-0">
                            For a reply that harms someone else: an address, a phone number, a threat. The reply is deleted from the server,
                            so nobody can read it again, here included, and members read your reason in its place. The member is told, and
                            can't write another reply on this vote. The vote itself carries on.
                        </p>
                        <label className="block text-xs font-bold text-nature-300" htmlFor="take-down-reply-reason">
                            Reason (members will see this)
                        </label>
                        <textarea
                            id="take-down-reply-reason"
                            value={takeDownReason}
                            onChange={(e) => setTakeDownReason(e.target.value)}
                            rows={3}
                            className="w-full rounded-xl bg-nature-950 border border-nature-700 text-sm text-white p-2"
                            placeholder="Why the reply is taken down"
                        />
                        <p className={`text-[11px] m-0 ${takeDownReasonOk ? 'text-nature-500' : 'text-amber-400'}`}>
                            {takeDownReasonOk ? `${takeDownTrimmed.length} characters` : `At least ${MIN_HALT_REASON} characters (${takeDownTrimmed.length} so far)`}
                        </p>
                        {takeDownError && <div className="p-2 rounded-lg bg-red-950/60 border border-red-800 text-xs text-red-300">{takeDownError}</div>}
                        <div className="flex justify-end gap-2 pt-1">
                            <button onClick={closeTakeDown} disabled={takingDown} className="px-3 py-2 rounded-lg bg-nature-800 hover:bg-nature-700 text-xs font-semibold text-white">
                                Cancel
                            </button>
                            <button
                                onClick={confirmTakeDown}
                                disabled={!takeDownReasonOk || takingDown}
                                className="px-3 py-2 rounded-lg bg-bp-danger-fill hover:bg-bp-danger-hover text-xs font-bold text-bp-danger-on disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {takingDown ? 'Taking down…' : 'Take down reply'}
                            </button>
                        </div>
                    </div>
                </ModalBackdrop>
            )}

            {decideTarget && (
                <ModalBackdrop onClose={closeDecide} dismissable={!deciding} className="fixed inset-0 overflow-y-auto bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Decide as owner">
                    <div className="m-auto w-full max-w-md bg-nature-900 border border-nature-800 rounded-3xl p-6 shadow-2xl space-y-3">
                        <h3 className="text-base font-bold text-white m-0 break-words">Decide the vote on removing {suspendedName(decideTarget)}?</h3>
                        <p className="text-xs text-nature-400 m-0">
                            Fewer than 3 members could vote, so this vote can't reach its turnout. As an owner you can decide it: if still
                            fewer than 3 could vote when it closes, {suspendedName(decideTarget)} stays paused for the 7 days of a removal's
                            grace, then is removed. If more members can vote by then, they decide. Every member reads your reason beside the
                            case, the member is told and can reply, and the owners are told. Any admin can still halt the removal in its grace.
                        </p>
                        <label className="block text-xs font-bold text-nature-300" htmlFor="owner-decision-reason">
                            Reason (members will see this)
                        </label>
                        <textarea
                            id="owner-decision-reason"
                            value={decideReason}
                            onChange={(e) => setDecideReason(e.target.value)}
                            rows={3}
                            className="w-full rounded-xl bg-nature-950 border border-nature-700 text-sm text-white p-2"
                            placeholder="Why you decide this removal"
                        />
                        <p className={`text-[11px] m-0 ${decideReasonOk ? 'text-nature-500' : 'text-amber-400'}`}>
                            {decideReasonOk ? `${decideTrimmed.length} characters` : `At least ${MIN_HALT_REASON} characters (${decideTrimmed.length} so far)`}
                        </p>
                        <FreshProofBox proof={proof} testId="owner-decision-proof" />
                        {decideError && <div className="p-2 rounded-lg bg-red-950/60 border border-red-800 text-xs text-red-300">{decideError}</div>}
                        <div className="flex justify-end gap-2 pt-1">
                            <button onClick={closeDecide} disabled={deciding} className="px-3 py-2 rounded-lg bg-nature-800 hover:bg-nature-700 text-xs font-semibold text-white">
                                Cancel
                            </button>
                            <button
                                onClick={() => confirmDecide()}
                                disabled={!decideReasonOk || deciding}
                                className="px-3 py-2 rounded-lg bg-bp-danger-fill hover:bg-bp-danger-hover text-xs font-bold text-bp-danger-on disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {deciding ? 'Deciding…' : 'Decide: remove if still too few'}
                            </button>
                        </div>
                    </div>
                </ModalBackdrop>
            )}

            {haltTarget && (
                <ModalBackdrop onClose={closeModal} dismissable={!halting} className="fixed inset-0 overflow-y-auto bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={haltIsLift ? 'Lift suspension' : 'Halt Decision'}>
                    <div className="m-auto w-full max-w-md bg-nature-900 border border-nature-800 rounded-3xl p-6 shadow-2xl space-y-3">
                        <h3 className="text-base font-bold text-white m-0 break-words">
                            {haltIsLift ? `Lift ${suspendedName(haltTarget)}'s suspension now?` : <>Halt “{haltTarget.title}”?</>}
                        </h3>
                        <p className="text-xs text-nature-400 m-0">
                            {haltIsLift
                                ? 'Lifting ends the suspension straight away, before its 7 days are up.'
                                : haltTarget.effect === 'keep_suspension' || (haltTarget.status === 'open' && isPauseVote(haltTarget))
                                ? 'Halting this vote lifts the suspension straight away.'
                                : haltTarget.status === 'execution_pending_grace'
                                    ? 'Halting stops the removal and restores the member.'
                                    : 'Halting closes the vote; nothing it proposed will happen.'}
                        </p>
                        <label className="block text-xs font-bold text-nature-300" htmlFor="halt-reason">
                            Reason (members will see this)
                        </label>
                        <textarea
                            id="halt-reason"
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            rows={3}
                            className="w-full rounded-xl bg-nature-950 border border-nature-700 text-sm text-white p-2"
                            placeholder={haltIsLift ? 'Why the suspension is being lifted' : 'Why this vote is being stopped'}
                        />
                        <p className={`text-[11px] m-0 ${reasonOk ? 'text-nature-500' : 'text-amber-400'}`}>
                            {reasonOk ? `${trimmed.length} characters` : `At least ${MIN_HALT_REASON} characters (${trimmed.length} so far)`}
                        </p>
                        {haltError && <div className="p-2 rounded-lg bg-red-950/60 border border-red-800 text-xs text-red-300">{haltError}</div>}
                        <div className="flex justify-end gap-2 pt-1">
                            <button onClick={closeModal} disabled={halting} className="px-3 py-2 rounded-lg bg-nature-800 hover:bg-nature-700 text-xs font-semibold text-white">
                                Cancel
                            </button>
                            <button
                                onClick={confirmHalt}
                                disabled={!reasonOk || halting}
                                className="px-3 py-2 rounded-lg bg-bp-danger-fill hover:bg-bp-danger-hover text-xs font-bold text-bp-danger-on disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {haltIsLift ? (halting ? 'Lifting…' : 'Lift suspension') : (halting ? 'Halting…' : 'Halt Decision')}
                            </button>
                        </div>
                    </div>
                </ModalBackdrop>
            )}
        </div>
    );
}
