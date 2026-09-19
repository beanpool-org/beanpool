import React, { useState, useEffect, useMemo } from 'react';
import type { MemberItem } from './MembersModule';
import { ModalBackdrop } from '../common/ModalBackdrop';

export interface PruneBranchModalProps {
    rootMember: MemberItem | null | undefined;
    members?: MemberItem[] | null;
    accounts?: Array<{ publicKey?: string; pubkey?: string; balance?: number | string }> | Record<string, { balance?: number | string }> | null;
    onConfirm: (pubkey: string) => Promise<void>;
    onClose: () => void;
}

export function PruneBranchModal({
    rootMember,
    members,
    accounts,
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

    const accountsMap = useMemo(() => {
        const map = new Map<string, number>();
        if (Array.isArray(accounts)) {
            for (const acc of accounts) {
                if (!acc) continue;
                const pk = typeof acc.publicKey === 'string' ? acc.publicKey : (typeof acc.pubkey === 'string' ? acc.pubkey : '');
                if (pk && acc.balance !== undefined) {
                    const num = Number(acc.balance);
                    if (!isNaN(num)) map.set(pk, num);
                }
            }
        } else if (accounts && typeof accounts === 'object') {
            for (const [pk, val] of Object.entries(accounts)) {
                if (val && typeof val === 'object' && 'balance' in val) {
                    const num = Number((val as any).balance);
                    if (!isNaN(num)) map.set(pk, num);
                } else if (typeof val === 'number') {
                    map.set(pk, val);
                }
            }
        }
        return map;
    }, [accounts]);

    // Compute the subtree of members invited by this branch root
    const { branchMembers, totalBalance, totalDebtWriteOff, totalCreditConfiscated } = useMemo(() => {
        if (!rootMember && !rootPubkey) {
            return { branchMembers: [], totalBalance: 0, totalDebtWriteOff: 0, totalCreditConfiscated: 0 };
        }

        const safeMembers = Array.isArray(members) ? members : [];
        const tree = new Map<string, MemberItem[]>();

        safeMembers.forEach((m) => {
            if (!m || typeof m !== 'object') return;
            const inv = typeof m.invitedBy === 'string'
                ? m.invitedBy
                : (typeof (m as any).invited_by === 'string' ? (m as any).invited_by : 'genesis');
            const list = tree.get(inv) || [];
            list.push(m);
            tree.set(inv, list);
        });

        const collected: MemberItem[] = [];
        const visited = new Set<string>();

        if (rootPubkey) {
            visited.add(rootPubkey);
        }
        if (rootMember) {
            collected.push(rootMember);
        }

        function walk(pk: string) {
            const children = tree.get(pk) || [];
            for (const child of children) {
                const cPk = typeof child.publicKey === 'string'
                    ? child.publicKey
                    : (typeof child.pubkey === 'string' ? child.pubkey : '');
                if (cPk && !visited.has(cPk)) {
                    visited.add(cPk);
                    collected.push(child);
                    walk(cPk);
                } else if (!cPk) {
                    collected.push(child);
                }
            }
        }

        if (rootPubkey) {
            walk(rootPubkey);
        }

        let totalDebtWriteOff = 0;
        let totalCreditConfiscated = 0;
        let sumBalance = 0;

        collected.forEach((m) => {
            if (!m || typeof m !== 'object') return;
            const pk = typeof m.publicKey === 'string' ? m.publicKey : (typeof (m as any).pubkey === 'string' ? (m as any).pubkey : '');
            let b = pk && accountsMap.has(pk) ? accountsMap.get(pk)! : (m.balance !== undefined ? Number(m.balance) : 0);
            if (isNaN(b)) b = 0;
            sumBalance += b;
            if (b < 0) {
                totalDebtWriteOff += Math.abs(b);
            } else if (b > 0) {
                totalCreditConfiscated += b;
            }
        });

        return {
            branchMembers: collected,
            totalBalance: Math.round(sumBalance * 100) / 100,
            totalDebtWriteOff: Math.round(totalDebtWriteOff * 100) / 100,
            totalCreditConfiscated: Math.round(totalCreditConfiscated * 100) / 100,
        };
    }, [rootMember, rootPubkey, members, accountsMap]);

    const isMatch = confirmText.trim() === rootName.trim() && rootName.trim().length > 0;

    const handlePrune = async () => {
        if (!isMatch || isPruning || !rootPubkey) return;
        setIsPruning(true);
        setErrorMessage(null);
        try {
            await onConfirm(rootPubkey);
            onClose();
        } catch (err: unknown) {
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

                {/* Branch Impact Metrics */}
                <div className="grid grid-cols-2 gap-3 bg-nature-950 p-4 rounded-xl border border-nature-800">
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
                        <span className="text-lg font-black text-amber-400 font-mono block">
                            {branchMembers.length}
                        </span>
                    </div>
                    <div className="col-span-2 pt-2 border-t border-nature-800/60 space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                            <span className="text-nature-300 font-medium">
                                Bad Debt to Settle:
                            </span>
                            <span className="font-bold text-red-400 font-mono" id="prune-debt-written-off">
                                {totalDebtWriteOff} 🫘 bad debt
                            </span>
                        </div>
                        <div className="flex items-center justify-between text-xs">
                            <span className="text-nature-300 font-medium">
                                Surplus Credit to Reclaim:
                            </span>
                            <span className="font-bold text-amber-400 font-mono" id="prune-credit-confiscated">
                                {totalCreditConfiscated} 🫘 credit
                            </span>
                        </div>
                        <div className="flex items-center justify-between text-xs pt-1 border-t border-nature-800/40">
                            <span className="text-nature-400 font-medium">
                                Net Commons Pool Impact:
                            </span>
                            <span className={`text-sm font-black font-mono ${totalCreditConfiscated >= totalDebtWriteOff ? 'text-emerald-400' : 'text-red-400'}`} id="prune-net-impact">
                                {Math.round((totalCreditConfiscated - totalDebtWriteOff) * 100) / 100 > 0 ? '+' : ''}
                                {Math.round((totalCreditConfiscated - totalDebtWriteOff) * 100) / 100} 🫘
                            </span>
                        </div>
                    </div>
                </div>

                {errorMessage && (
                    <div role="alert" className="p-3 rounded-xl bg-red-950/80 border border-red-800 text-xs font-semibold text-red-300">
                        ❌ {errorMessage}
                    </div>
                )}

                {/* Type-To-Confirm Safeguard */}
                <div className="space-y-2">
                    <label htmlFor="prune-branch-confirm-input" className="block text-xs font-bold text-nature-300">
                        To confirm, type the branch root name <span className="text-terra-400 font-mono font-black break-all">&quot;{rootName}&quot;</span> below:
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
                        onClick={handlePrune}
                        disabled={!isMatch || isPruning || !rootPubkey}
                        className="min-h-[44px] px-5 py-2.5 rounded-xl bg-red-800 hover:bg-red-700 active:scale-[0.99] text-xs font-bold text-white border border-red-600 shadow-md transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
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
