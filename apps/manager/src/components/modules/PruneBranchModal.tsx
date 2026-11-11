import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { MemberItem } from './MembersModule';
import { BranchPruneRefusedError, type BranchPruneFigures } from '../../lib/node-client';
import { ModalBackdrop } from '../common/ModalBackdrop';
import { FreshProofBox, useFreshProof } from '../common/FreshProofBox';
import { beansFigure } from '../../lib/beans';

export interface PruneBranchModalProps {
    rootMember: MemberItem | null | undefined;
    /**
     * The branch's figures from the node (lib/node-client fetchBranchPruneFigures): the whole branch the node prunes. Not the
     * console's members, which hold only the pages read so far (capacity fix 3), so the prune is never confirmed on a part.
     */
    loadFigures: (pubkey: string) => Promise<BranchPruneFigures>;
    /** Rejects with FreshProofRequiredError when the branch holds an owner and the node asks an owner's fresh proof. */
    onConfirm: (pubkey: string, code?: string) => Promise<void>;
    onClose: () => void;
}

export function PruneBranchModal({
    rootMember,
    loadFigures,
    onConfirm,
    onClose,
}: PruneBranchModalProps) {
    const [confirmText, setConfirmText] = useState('');
    const [isPruning, setIsPruning] = useState(false);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    const rootPubkey = typeof rootMember?.publicKey === 'string'
        ? rootMember.publicKey
        : (typeof rootMember?.pubkey === 'string' ? rootMember.pubkey : '');

    const rootName = (rootMember?.callsign && typeof rootMember.callsign === 'string' && rootMember.callsign.trim())
        ? rootMember.callsign.trim()
        : (rootMember?.name && typeof rootMember.name === 'string' && rootMember.name.trim())
            ? rootMember.name.trim()
            : (rootPubkey ? rootPubkey.slice(0, 8) : 'Unknown Root');

    // The node's figures for the whole branch. Confirm stays off until they are in: an irreversible prune is never
    // confirmed on figures the console made up from part of the branch, or on none.
    const [figures, setFigures] = useState<BranchPruneFigures | null>(null);
    const [figuresError, setFiguresError] = useState<string | null>(null);
    // The node's own refusal of this prune (BranchPruneRefusedError), in its words: no figures, and no Try again.
    const [figuresRefusal, setFiguresRefusal] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    // Read once for the branch and again on Try again, not each time a parent hands a new loader.
    const loadRef = useRef(loadFigures);
    loadRef.current = loadFigures;
    useEffect(() => {
        if (!rootPubkey) return;
        let live = true;
        setFigures(null);
        setFiguresError(null);
        setFiguresRefusal(null);
        // A loader that throws, or answers no figures, is a read that failed: Confirm stays off and the dialog says so.
        // The node refusing this prune is not a failed read: its words are shown as they are, and Confirm stays off.
        Promise.resolve().then(() => loadRef.current(rootPubkey)).then(
            (f) => {
                if (!live) return;
                if (f && typeof f.members === 'number') setFigures(f);
                else setFiguresError("The node's answer has no figures for this branch");
            },
            (e: unknown) => {
                if (!live) return;
                if (e instanceof BranchPruneRefusedError) setFiguresRefusal(e.message);
                else setFiguresError(e instanceof Error ? e.message : String(e));
            },
        );
        return () => { live = false; };
    }, [rootPubkey, attempt]);
    const retryFigures = useCallback(() => setAttempt((n) => n + 1), []);
    const figuresLoading = !!rootPubkey && !figures && !figuresError && !figuresRefusal;
    // The members count as it is; the three money figures are whole hundredths of a Bean (server branchPrunePreview's *_c), in words.
    const shown = (n: number | undefined) => (figures && typeof n === 'number' ? String(n) : figuresLoading ? '…' : '—');
    const shownBeans = (n: number | undefined) => (figures && typeof n === 'number' ? beansFigure(n) : figuresLoading ? '…' : '—');
    const net = figures ? figures.net_c : null;

    const isMatch = confirmText.trim() === rootName.trim() && rootName.trim().length > 0;

    // Removing a branch with an owner in it asks an owner's fresh proof each time (server ownerRemovalProof).
    const proof = useFreshProof();

    const handlePrune = async (code?: string) => {
        if (!isMatch || isPruning || !rootPubkey || !figures) return;
        setIsPruning(true);
        setErrorMessage(null);
        try {
            await onConfirm(rootPubkey, ...(code ? [code] : []));
            proof.close();
            onClose();
        } catch (err: unknown) {
            if (proof.checkError(err, (c) => handlePrune(c), code)) {
                setIsPruning(false);
                return;
            }
            setErrorMessage(err instanceof Error ? err.message : 'Failed to prune branch');
            setIsPruning(false);
        }
    };

    return (
        <ModalBackdrop
            onClose={onClose}
            dismissable={!isPruning}
            role="dialog"
            aria-modal="true"
            aria-labelledby="prune-branch-title"
            className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-sm animate-fade-in overflow-y-auto"
        >
            <div className="m-auto bg-nature-900 border border-red-700/80 rounded-2xl p-5 sm:p-6 max-w-lg w-full shadow-2xl space-y-5 text-nature-100 font-sans my-auto">
                <div className="flex items-start justify-between gap-3 border-b border-nature-800 pb-3">
                    <div className="min-w-0 flex-1">
                        <h3 id="prune-branch-title" className="text-base sm:text-lg font-black text-white flex items-center gap-2 m-0 text-red-300">
                            <span>⚠️</span>
                            <span>Prune Invite Branch</span>
                        </h3>
                        <p className="text-xs text-nature-400 m-0 mt-1">
                            Permanent administrative removal of an entire invite subtree
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => { if (!isPruning) onClose(); }}
                        disabled={isPruning}
                        aria-label="Close prune branch dialog"
                        className="shrink-0 text-nature-400 hover:text-white p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg hover:bg-nature-800 transition-colors disabled:opacity-50"
                    >
                        ✕
                    </button>
                </div>

                {/* Destructive Notice */}
                <div className="p-3.5 bg-red-950/70 border border-red-800/80 rounded-xl space-y-1.5 text-xs text-red-200">
                    <p className="font-bold text-red-300 m-0 flex items-center gap-1.5">
                        <span>🛑</span>
                        <span>DESTRUCTIVE PROTOCOL ACTION</span>
                    </p>
                    <p className="m-0 leading-relaxed text-red-200/90 text-[11px] sm:text-xs">
                        This action will permanently delete the branch root member and all downstream invitees who were invited through this lineage.
                        All outstanding balances in this branch will be written off to the commons pool.
                    </p>
                </div>

                {/* Branch Impact Metrics: the node's, for the whole branch */}
                <div
                    className="grid grid-cols-2 gap-3 bg-nature-950 p-4 rounded-xl border border-nature-800"
                    aria-busy={figuresLoading}
                    data-testid="prune-branch-figures"
                >
                    <div>
                        <span className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400 block">
                            Branch Root
                        </span>
                        <span className="text-xs font-bold text-white font-mono block truncate" title={rootPubkey}>
                            {rootName}
                        </span>
                        {rootPubkey && (
                            <span className="text-[10px] text-nature-500 font-mono block truncate">
                                {rootPubkey.slice(0, 10)}...
                            </span>
                        )}
                    </div>
                    <div>
                        <span className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400 block">
                            Members Affected
                        </span>
                        <span className="text-lg font-black text-amber-400 font-mono block" id="prune-members-affected">
                            {shown(figures?.members)}
                        </span>
                    </div>
                    <div className="col-span-2 pt-2 border-t border-nature-800/60 space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                            <span className="text-nature-300 font-medium">
                                Bad Debt to Settle:
                            </span>
                            <span className="font-bold text-red-400 font-mono" id="prune-debt-written-off">
                                {shownBeans(figures?.badDebt_c)} 🫘 bad debt
                            </span>
                        </div>
                        <div className="flex items-center justify-between text-xs">
                            <span className="text-nature-300 font-medium">
                                Surplus Credit to Reclaim:
                            </span>
                            <span className="font-bold text-amber-400 font-mono" id="prune-credit-confiscated">
                                {shownBeans(figures?.surplus_c)} 🫘 credit
                            </span>
                        </div>
                        <div className="flex items-center justify-between text-xs pt-1 border-t border-nature-800/40">
                            <span className="text-nature-400 font-medium">
                                Net Commons Pool Impact:
                            </span>
                            <span className={`text-sm font-black font-mono ${net === null ? 'text-nature-400' : net >= 0 ? 'text-emerald-400' : 'text-red-400'}`} id="prune-net-impact">
                                {net !== null && net > 0 ? '+' : ''}
                                {shownBeans(figures?.net_c)} 🫘
                            </span>
                        </div>
                    </div>
                    {figuresLoading && (
                        <p role="status" className="col-span-2 m-0 text-[11px] text-nature-400" data-testid="prune-figures-loading">
                            Reading the whole branch from the node…
                        </p>
                    )}
                </div>
                {figuresRefusal && (
                    <div role="alert" data-testid="prune-figures-refused" className="p-3 rounded-xl bg-red-950/80 border border-red-800 text-xs font-semibold text-red-300">
                        <p className="m-0 break-words">{figuresRefusal}</p>
                    </div>
                )}
                {figuresError && (
                    <div role="alert" data-testid="prune-figures-error" className="p-3 rounded-xl bg-red-950/80 border border-red-800 text-xs font-semibold text-red-300 space-y-2">
                        <p className="m-0 break-words">
                            Couldn't read this branch from the node, so it can't be pruned until its figures are in: {figuresError}
                        </p>
                        <button
                            type="button"
                            onClick={retryFigures}
                            className="min-h-[44px] px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white transition-all"
                        >
                            Try again
                        </button>
                    </div>
                )}

                <FreshProofBox proof={proof} testId="prune-branch-proof" />
                {errorMessage && (
                    <div role="alert" className="p-3 rounded-xl bg-red-950/80 border border-red-800 text-xs font-semibold text-red-300">
                        ❌ {errorMessage}
                    </div>
                )}

                {/* Type-To-Confirm Safeguard */}
                <div className="space-y-2">
                    <label htmlFor="prune-branch-confirm-input" className="block text-xs font-bold text-nature-300">
                        To confirm, type the branch root name <span className="text-bp-ink-terra font-mono font-black break-all">&quot;{rootName}&quot;</span> below:
                    </label>
                    <input
                        id="prune-branch-confirm-input"
                        type="text"
                        value={confirmText}
                        onChange={(e) => setConfirmText(e.target.value)}
                        placeholder={`Type "${rootName}" to confirm`}
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck="false"
                        className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2.5 text-sm text-white font-mono focus:outline-none focus:border-red-500 min-h-[44px]"
                    />
                </div>

                {/* Action Buttons */}
                <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-end gap-2.5 pt-2">
                    <button
                        type="button"
                        onClick={() => { if (!isPruning) onClose(); }}
                        disabled={isPruning}
                        className="min-h-[44px] px-4 py-2.5 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white transition-all disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        id="confirm-prune-branch-btn"
                        onClick={() => handlePrune()}
                        disabled={!isMatch || isPruning || !rootPubkey || !figures}
                        className="min-h-[44px] px-5 py-2.5 rounded-xl bg-bp-danger-fill hover:bg-bp-danger-hover active:scale-[0.99] text-xs font-bold text-bp-danger-on border border-bp-danger-fill shadow-md transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                        {isPruning ? (
                            <>
                                <span className="animate-spin text-sm">🔄</span>
                                <span>Pruning Branch...</span>
                            </>
                        ) : (
                            <span>🗑️ Prune Entire Branch</span>
                        )}
                    </button>
                </div>
            </div>
        </ModalBackdrop>
    );
}
