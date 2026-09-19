import React, { useEffect, useState } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { fetchAdminDecisions, haltDecision, type AdminDecisionItem } from '../../lib/node-client';

interface DecisionsAdminPanelProps {
    activeNode: NodeProfile;
    tfaToken?: string;
}

/** The node demands at least this many characters; the reason is public on the Decision. */
export const MIN_HALT_REASON = 10;

function formatDate(iso: string | null | undefined): string {
    if (!iso) return '';
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t).toLocaleDateString() : '';
}

/**
 * Community Decisions an admin can still act on — open votes and removals in their 7-day grace window —
 * with the admin brake: halt, with a written reason members will see. Totals only; the node never serves
 * who voted how.
 */
export function DecisionsAdminPanel({ activeNode, tfaToken }: DecisionsAdminPanelProps) {
    const [decisions, setDecisions] = useState<AdminDecisionItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [haltTarget, setHaltTarget] = useState<AdminDecisionItem | null>(null);
    const [reason, setReason] = useState('');
    const [halting, setHalting] = useState(false);
    const [haltError, setHaltError] = useState<string | null>(null);

    const load = async () => {
        if (!activeNode?.url) return;
        setLoading(true);
        setError(null);
        try {
            setDecisions(await fetchAdminDecisions(activeNode.url, activeNode.adminPassword, tfaToken));
        } catch (err: any) {
            setError(err?.message || 'Failed to load Decisions');
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

    const confirmHalt = async () => {
        if (!haltTarget || !reasonOk) return;
        setHalting(true);
        setHaltError(null);
        try {
            await haltDecision(activeNode.url, haltTarget.id, trimmed, activeNode.adminPassword, tfaToken);
            setHaltTarget(null);
            setReason('');
            await load();
        } catch (err: any) {
            setHaltError(err?.message || 'Failed to halt the Decision');
        } finally {
            setHalting(false);
        }
    };

    return (
        <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4">
            <div className="flex flex-wrap lg:flex-nowrap items-center justify-between gap-3 lg:gap-0">
                <div className="min-w-0">
                    <h3 className="text-base font-bold text-white m-0">Community Decisions ({decisions.length})</h3>
                    <p className="text-xs text-nature-400 m-0 mt-0.5">
                        Open votes and removals waiting out their 7 days. Halting stops one; your reason is shown to members.
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

            {!error && decisions.length === 0 && !loading && (
                <div className="py-6 text-center text-xs text-nature-400">No open Decisions.</div>
            )}

            <div className="space-y-3">
                {decisions.map((d) => {
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
                            <div className="flex justify-end">
                                <button
                                    onClick={() => { setHaltTarget(d); setReason(''); setHaltError(null); }}
                                    className="px-3 py-2 rounded-lg bg-red-950/80 hover:bg-red-900 text-xs font-bold text-red-200 border border-red-800"
                                >
                                    Halt this Decision
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>

            {haltTarget && (
                <div className="fixed inset-0 overflow-y-auto bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Halt Decision">
                    <div className="m-auto w-full max-w-md bg-nature-900 border border-nature-800 rounded-3xl p-6 shadow-2xl space-y-3">
                        <h3 className="text-base font-bold text-white m-0">Halt “{haltTarget.title}”?</h3>
                        <p className="text-xs text-nature-400 m-0">
                            {haltTarget.effect === 'keep_suspension'
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
                            placeholder="Why this vote is being stopped"
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
                                className="px-3 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-xs font-bold text-white disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {halting ? 'Halting…' : 'Halt Decision'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
