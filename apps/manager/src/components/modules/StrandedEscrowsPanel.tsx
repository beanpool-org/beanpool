import React, { useCallback, useEffect, useState } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import {
    fetchStrandedEscrows,
    writeOffStrandedEscrow,
    StrandedEscrowWriteOffError,
    getTfaSessionToken,
    type StrandedEscrowItem,
    type StrandedEscrowsResponse,
} from '../../lib/node-client';

// The server's bounds (engine/escrow-write-off.ts); it checks them again.
const REASON_MIN = 10;
const REASON_MAX = 300;

function beans(n: number): string {
    return `${Number(n.toFixed(4))} Beans`;
}

function day(ts: string | null | undefined): string {
    if (!ts) return '—';
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? ts : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

interface StrandedEscrowsPanelProps {
    activeNode: NodeProfile;
    /** The latest audit result. A new one reloads the list. */
    refreshKey: unknown;
    /** Owner level: an owner's key or the password. Anyone else sees the list without the action. */
    canWriteOff: boolean;
    isStandby: boolean;
    /** Called after a write-off, to run the audit again. */
    onWrittenOff: () => void | Promise<void>;
}

/**
 * The escrows the ledger audit counts as stranded, and, for a NEGATIVE one, writing it off from the Commons
 * (server: engine/escrow-write-off.ts). A negative escrow is a hole the old post-removal refund dug: the buyer
 * already has the Beans, so the community covers it. A positive one holds a member's Beans and is never the
 * Commons' to take; it is listed so the count matches, without the action.
 */
export function StrandedEscrowsPanel({ activeNode, refreshKey, canWriteOff, isStandby, onWrittenOff }: StrandedEscrowsPanelProps) {
    const [data, setData] = useState<StrandedEscrowsResponse | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [openId, setOpenId] = useState<string | null>(null);
    const [reason, setReason] = useState('');
    const [confirmDeficit, setConfirmDeficit] = useState(false);
    // The Commons can move between listing and writing off; the server's figures then replace the listed ones.
    const [serverDeficit, setServerDeficit] = useState<{ commonsBalance: number; commonsAfter: number } | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [formError, setFormError] = useState<string | null>(null);
    const [done, setDone] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setData(await fetchStrandedEscrows(activeNode.url, activeNode.adminPassword, getTfaSessionToken(activeNode.id)));
            setLoadError(null);
        } catch (e: unknown) {
            setLoadError(e instanceof Error ? e.message : 'Could not load the stranded escrows');
        }
    }, [activeNode.id, activeNode.url, activeNode.adminPassword]);

    useEffect(() => {
        if (refreshKey) load();
    }, [refreshKey, load]);

    const open = (id: string | null) => {
        setOpenId(id);
        setReason('');
        setConfirmDeficit(false);
        setServerDeficit(null);
        setFormError(null);
    };

    const submit = async (escrow: StrandedEscrowItem) => {
        setSubmitting(true);
        setFormError(null);
        try {
            const res = await writeOffStrandedEscrow(
                activeNode.url, escrow.escrowId, reason.trim(), confirmDeficit,
                activeNode.adminPassword, getTfaSessionToken(activeNode.id),
            );
            setDone(`Wrote off ${beans(res.amount)} from the Commons for trade ${res.tradeId.slice(0, 8)}. The Commons now reads ${beans(res.commonsAfter)}.`);
            open(null);
            await load();
            await onWrittenOff();
        } catch (e: unknown) {
            if (e instanceof StrandedEscrowWriteOffError && e.code === 'deficit_unconfirmed'
                && typeof e.commonsBalance === 'number' && typeof e.commonsAfter === 'number') {
                setServerDeficit({ commonsBalance: e.commonsBalance, commonsAfter: e.commonsAfter });
                setConfirmDeficit(false);
            }
            setFormError(e instanceof Error ? e.message : 'Write-off failed');
        } finally {
            setSubmitting(false);
        }
    };

    const escrows = data?.escrows ?? [];
    if (!loadError && escrows.length === 0 && !done) return null;

    return (
        <div className="space-y-3">
            <div>
                <h4 className="text-sm font-bold text-white m-0">Stranded escrows</h4>
                <p className="text-xs text-nature-400 m-0 mt-0.5">
                    An escrow below zero paid out Beans it never held, before escrows had a floor. The buyer already has them,
                    so the community covers the hole from the Commons, on the record.
                </p>
            </div>

            {loadError && <div className="text-xs text-red-400">{loadError}</div>}
            {done && (
                <div className="p-3 rounded-xl bg-emerald-950/60 border border-emerald-500/30 text-xs text-emerald-200">{done}</div>
            )}

            {data && data.eligibleCount > 0 && (
                <div className="text-xs text-nature-400">
                    The Commons reads <span className="font-mono text-white">{beans(data.commonsBalance)}</span>.
                    Writing off all {data.eligibleCount} would leave it at{' '}
                    <span className={`font-mono ${data.commonsAfterAll < 0 ? 'text-amber-300' : 'text-white'}`}>{beans(data.commonsAfterAll)}</span>.
                </div>
            )}
            {data && data.eligibleCount > 0 && isStandby && (
                <div className="text-xs text-amber-300">This node is a standby. Write these off on the main server; the standby picks them up with the next sync.</div>
            )}
            {data && data.eligibleCount > 0 && !isStandby && !canWriteOff && (
                <div className="text-xs text-nature-400 italic">Only an owner of this node can write one off.</div>
            )}

            {escrows.map(e => {
                const isOpen = openId === e.escrowId;
                const commonsNow = serverDeficit?.commonsBalance ?? data?.commonsBalance ?? 0;
                const commonsAfter = serverDeficit?.commonsAfter ?? e.writeOff.commonsAfter ?? commonsNow + e.balance;
                // Whether there is a deficit is the server's call, made on the exact figures. The ones it sends are
                // rounded to the cent, so a Commons short by less than a cent reads 0 after, yet still needs the
                // confirmation: a deficit refusal, or the listing's own flag, decides it — never the rounded figure.
                const deficit = serverDeficit !== null || e.writeOff.wouldDeficit;
                const afterText = deficit && commonsAfter >= 0 ? 'just under 0 Beans' : beans(commonsAfter);
                const reasonOk = reason.trim().length >= REASON_MIN;
                const reasonId = `write-off-reason-${e.escrowId}`;
                return (
                    <div key={e.escrowId} className="p-4 rounded-xl bg-nature-950 border border-nature-800 text-xs space-y-2">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <span className="font-mono text-nature-300 break-all" title={e.escrowId}>escrow_{e.tradeId.slice(0, 8)}…</span>
                            <span className={`font-mono font-bold ${e.balance < 0 ? 'text-red-400' : 'text-white'}`}>{beans(e.balance)}</span>
                        </div>
                        <div className="text-nature-400">
                            {e.trade
                                ? <>Trade {e.trade.status}, opened {day(e.trade.createdAt)}{e.trade.completedAt ? `, closed ${day(e.trade.completedAt)}` : ''}</>
                                : <>This node has no trade row for it</>}
                            {e.lastTransaction && <> · last: “{e.lastTransaction.memo}”, {day(e.lastTransaction.timestamp)}</>}
                        </div>

                        {!e.writeOff.eligible && e.writeOff.refusal && (
                            <div className="text-nature-400 italic">{e.writeOff.refusal}</div>
                        )}

                        {e.writeOff.eligible && canWriteOff && !isStandby && !isOpen && (
                            <button
                                onClick={() => open(e.escrowId)}
                                className="px-3.5 py-1.5 rounded-lg bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all"
                            >
                                Write off from the Commons
                            </button>
                        )}

                        {isOpen && (
                            <div className="pt-2 border-t border-nature-800 space-y-3">
                                <div>
                                    <label htmlFor={reasonId} className="block text-xs font-bold text-nature-300 mb-1">
                                        Reason (recorded on the ledger)
                                    </label>
                                    <textarea
                                        id={reasonId}
                                        value={reason}
                                        maxLength={REASON_MAX}
                                        rows={2}
                                        onChange={(ev) => setReason(ev.target.value)}
                                        placeholder="e.g. Refund from an escrow that was never funded (before escrows had a floor)"
                                        className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-terra-500"
                                    />
                                    <div className="text-nature-400 mt-0.5">
                                        {reasonOk ? `${reason.trim().length}/${REASON_MAX}` : `At least ${REASON_MIN} characters`}
                                    </div>
                                </div>

                                <div className="text-nature-400">
                                    The Commons now: <span className="font-mono text-white">{beans(commonsNow)}</span>
                                    {' · '}after this write-off:{' '}
                                    <span className={`font-mono font-bold ${deficit ? 'text-amber-300' : 'text-white'}`}>{afterText}</span>
                                </div>

                                {deficit && (
                                    <div className="p-3 rounded-xl bg-amber-950/70 border border-amber-500/50 text-amber-200 space-y-2">
                                        <div>
                                            This leaves the Commons in deficit, at {afterText}. That is the honest record of a community
                                            that has paid out more than it collected; every account still sums to zero.
                                        </div>
                                        <label className="flex items-start gap-2 cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={confirmDeficit}
                                                onChange={(ev) => setConfirmDeficit(ev.target.checked)}
                                                className="mt-0.5 rounded border-nature-700 text-terra-500 focus:ring-0"
                                            />
                                            <span>I confirm the Commons goes to {afterText}</span>
                                        </label>
                                    </div>
                                )}

                                {formError && <div className="text-red-400">{formError}</div>}

                                <div className="flex flex-wrap gap-2">
                                    <button
                                        onClick={() => submit(e)}
                                        disabled={submitting || !reasonOk || (deficit && !confirmDeficit)}
                                        className="px-3.5 py-1.5 rounded-lg bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all disabled:opacity-50"
                                    >
                                        {submitting ? 'Writing off…' : `Write off ${beans(-e.balance)} from the Commons`}
                                    </button>
                                    <button
                                        onClick={() => open(null)}
                                        disabled={submitting}
                                        className="px-3.5 py-1.5 rounded-lg bg-nature-800 hover:bg-nature-700 border border-nature-700 text-xs font-bold text-white transition-all disabled:opacity-50"
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
