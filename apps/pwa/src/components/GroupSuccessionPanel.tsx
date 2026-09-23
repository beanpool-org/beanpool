/**
 * The quiet-lead vote, on the group's own screen (2026-09-23).
 *
 * A group's lead convenor cannot be removed or demoted by anyone — node admins included — so a lead who has gone
 * quiet, or whose account has been suspended, leaves the group with one way out: the 30-day-silence vote. It has
 * been on the server since 2026-09-19 with nothing calling it. This is what calls it.
 *
 * The shape follows the enterprise succession panel on TreasuryDetailPage: an amber card, the tally, the deadline,
 * Yes/No. What it may show is decided in lib/group-succession, from `silence`, `proposals` and `canPropose` and
 * nothing else — the server is the authority on who may propose and who may vote, and its refusal is what a member
 * reads when this guesses wrong. A healthy group sees nothing here at all.
 */

import { useCallback, useEffect, useState } from 'react';
import {
    getGroupSuccession, proposeGroupSuccession, voteGroupSuccession, isRouteMissing,
    type GroupMember, type GroupSuccessionData,
} from '../lib/api';
import { buildSuccessionView, voteConfirmText } from '../lib/group-succession';

interface Props {
    groupId: string;
    /** The roster the modal already holds: the picker offers the electorate out of it. */
    members: GroupMember[];
    myPubkey?: string;
    /** A vote that passes moves the lead, so the screen around this has to read itself again. */
    onLeadChanged?: () => void;
}

export function GroupSuccessionPanel({ groupId, members, myPubkey, onLeadChanged }: Props) {
    const [data, setData] = useState<GroupSuccessionData | null>(null);
    const [candidate, setCandidate] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setData(await getGroupSuccession(groupId));
        } catch (e) {
            // A node older than the route answers 404: show nothing, say nothing. Anything else is also not
            // worth an error about a section the group may never need.
            if (!isRouteMissing(e)) console.warn('[GroupSuccession] Could not read the lead vote:', e);
            setData(null);
        }
    }, [groupId]);

    useEffect(() => { void load(); }, [load]);

    const view = buildSuccessionView(data, members);

    const handlePropose = async (e: React.FormEvent) => {
        e.preventDefault();
        if (busy || !candidate) return;
        setBusy(true);
        setError(null);
        try {
            const res = await proposeGroupSuccession(groupId, candidate);
            setCandidate('');
            await load();
            // A group whose lead is its only convenor can be one person: the proposal is the proposer's yes, and
            // that can already settle it.
            if (res?.executed && onLeadChanged) onLeadChanged();
        } catch (err: any) {
            // The server's own words. It knows who may stand and who may propose; this does not.
            setError(err?.message || 'Could not propose a new lead.');
        } finally {
            setBusy(false);
        }
    };

    const handleVote = async (choice: 'yes' | 'no') => {
        const open = view.openProposal;
        if (busy || !open) return;
        if (!window.confirm(voteConfirmText(choice, open.candidateCallsign))) return;
        setBusy(true);
        setError(null);
        try {
            const res = await voteGroupSuccession(groupId, open.id, choice);
            await load();
            if (res?.executed && onLeadChanged) onLeadChanged();
        } catch (err: any) {
            setError(err?.message || 'Could not record your vote.');
        } finally {
            setBusy(false);
        }
    };

    if (!view.show) return null;

    const open = view.openProposal;
    const candidateName = open?.candidateCallsign || open?.candidatePubkey.slice(0, 10) || '';

    return (
        <section
            aria-labelledby="group-lead-vote-heading"
            className="bg-amber-50/60 dark:bg-amber-950/30 border-2 border-amber-500/50 rounded-2xl p-4 space-y-3 shadow-sm"
        >
            <h3 id="group-lead-vote-heading" className="text-xs font-black uppercase tracking-wider text-amber-800 dark:text-amber-300">
                <span aria-hidden="true">⚠️ </span>Choosing a new lead convenor
            </h3>

            {view.silenceLine && (
                <p className="text-xs text-amber-900 dark:text-amber-200 leading-relaxed">{view.silenceLine}</p>
            )}

            {error && (
                <div className="p-3 bg-red-100 dark:bg-red-950/40 border border-red-300 dark:border-red-800 rounded-xl text-xs text-red-700 dark:text-red-300">
                    {error}
                </div>
            )}

            {open ? (
                <div className="bg-white dark:bg-nature-900 border border-amber-300 dark:border-amber-800 rounded-xl p-3 space-y-2">
                    <div className="text-xs font-bold text-nature-900 dark:text-white">
                        Proposed as the new lead: <span className="text-emerald-700 dark:text-emerald-400 font-extrabold">{candidateName}</span>
                    </div>
                    {view.closingLine && (
                        <div className="text-xs text-nature-600 dark:text-nature-400">
                            <span aria-hidden="true">⏳ </span>{view.closingLine}
                        </div>
                    )}
                    {/* Totals only. Who voted which way is nobody's business but their own, and the server never
                        sends it: there is no voter list here to leak. */}
                    <div className="text-xs text-nature-600 dark:text-nature-400">{view.tallyLine}</div>
                    <div className="text-[11px] text-nature-500 dark:text-nature-500 leading-relaxed">
                        It passes if more than half of those who answer say yes. Votes are secret, and nobody sees who voted which way.
                    </div>

                    {view.myVote ? (
                        <div className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 rounded-lg border border-emerald-200 dark:border-emerald-800">
                            <span aria-hidden="true">✓</span>
                            <span>You voted {view.myVote}. Votes can't be changed.</span>
                        </div>
                    ) : view.canVote ? (
                        // flex-wrap so the pair stacks rather than overflowing at 320px with 1.3× text.
                        <div className="flex flex-wrap gap-2">
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => handleVote('yes')}
                                aria-label={`Vote yes to make ${candidateName} the lead convenor`}
                                className="flex-1 min-w-[7rem] py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-sm transition-all disabled:opacity-50 min-h-[48px]"
                            >
                                {busy ? 'Voting…' : 'Yes'}
                            </button>
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => handleVote('no')}
                                aria-label={`Vote no to making ${candidateName} the lead convenor`}
                                className="flex-1 min-w-[7rem] py-2.5 px-4 rounded-xl border border-nature-300 dark:border-nature-700 text-nature-800 dark:text-nature-200 font-bold text-xs transition-all disabled:opacity-50 min-h-[48px]"
                            >
                                No
                            </button>
                        </div>
                    ) : null}
                </div>
            ) : view.canPropose ? (
                <form onSubmit={handlePropose} className="bg-white dark:bg-nature-900 border border-amber-300 dark:border-amber-800 rounded-xl p-3 space-y-2">
                    <label htmlFor="group-lead-candidate" className="block text-xs font-bold text-nature-800 dark:text-nature-200">
                        Propose a new lead
                    </label>
                    <div className="flex flex-col sm:flex-row gap-2">
                        <select
                            id="group-lead-candidate"
                            value={candidate}
                            onChange={(e) => setCandidate(e.target.value)}
                            className="flex-1 bg-nature-50 dark:bg-nature-800 border border-nature-300 dark:border-nature-700 rounded-xl px-3 py-2 text-xs font-semibold text-nature-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500 min-h-[44px]"
                        >
                            <option value="">Choose someone…</option>
                            {view.candidates.map((m) => (
                                <option key={m.memberPubkey} value={m.memberPubkey}>
                                    {(m.callsign || m.memberPubkey.slice(0, 10)) + (m.memberPubkey === myPubkey ? ' (yourself)' : '')}
                                </option>
                            ))}
                        </select>
                        <button
                            type="submit"
                            disabled={busy || !candidate}
                            className="py-2 px-4 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs shadow-sm transition-all disabled:opacity-50 shrink-0 min-h-[44px]"
                        >
                            {busy ? 'Proposing…' : 'Propose'}
                        </button>
                    </div>
                    <p className="text-[11px] text-nature-500 dark:text-nature-500 leading-relaxed">
                        Proposing counts as your yes. The vote runs for 14 days, and closes at once if the lead comes back.
                    </p>
                </form>
            ) : null}

            {view.outcomeLine && (
                <p className="text-xs text-nature-700 dark:text-nature-300 leading-relaxed">{view.outcomeLine}</p>
            )}
        </section>
    );
}
