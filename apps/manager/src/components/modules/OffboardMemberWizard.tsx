import React, { useState, useEffect, useRef } from 'react';
import {
    fetchOffboardPreviewApi,
    executeOffboardApi,
    type OffboardPreviewResponse,
} from '../../lib/node-client';

export interface OffboardMemberWizardProps {
    member: {
        publicKey: string;
        callsign: string;
        status?: string;
        avatarUrl?: string;
    };
    nodeUrl: string;
    adminPassword?: string;
    tfaToken?: string;
    currentAdminPubkey?: string;
    hasKeyAuth?: boolean;
    onSuccess?: () => void;
    onClose: () => void;
}

export function OffboardMemberWizard({
    member,
    nodeUrl,
    adminPassword,
    tfaToken,
    currentAdminPubkey,
    hasKeyAuth = false,
    onSuccess,
    onClose,
}: OffboardMemberWizardProps) {
    const [preview, setPreview] = useState<OffboardPreviewResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Resolution choice for positive balances
    const [resolutionChoice, setResolutionChoice] = useState<'donate_to_commons' | 'gift_to_member'>('donate_to_commons');
    const [giftRecipient, setGiftRecipient] = useState<string>('');

    // Execution state
    const [submitting, setSubmitting] = useState(false);
    const [completed, setCompleted] = useState(false);

    useEffect(() => {
        let mounted = true;
        const loadPreview = async () => {
            setLoading(true);
            setError(null);
            try {
                const data = await fetchOffboardPreviewApi(nodeUrl, member.publicKey, adminPassword, tfaToken);
                if (mounted) {
                    setPreview(data);
                    if (data.activeMembers.length > 0) {
                        setGiftRecipient(data.activeMembers[0].publicKey);
                    } else {
                        setResolutionChoice('donate_to_commons');
                    }
                }
            } catch (err: any) {
                if (mounted) {
                    setError(err?.message || 'Failed to load offboard preview');
                }
            } finally {
                if (mounted) {
                    setLoading(false);
                }
            }
        };
        loadPreview();
        return () => {
            mounted = false;
        };
    }, [nodeUrl, member.publicKey, adminPassword, tfaToken]);

    // Two-person rule check: Actor cannot gift to themselves
    const isSelfDealing = Boolean(
        hasKeyAuth &&
        preview &&
        preview.balance > 0 &&
        resolutionChoice === 'gift_to_member' &&
        currentAdminPubkey &&
        giftRecipient.toLowerCase() === currentAdminPubkey.toLowerCase()
    );

    const submittingRef = useRef(false);

    const handleConfirmOffboard = async () => {
        if (!preview) return;
        if (submittingRef.current || submitting) return;
        if (isSelfDealing) {
            setError('Two-person rule: You cannot gift this balance to yourself.');
            return;
        }

        submittingRef.current = true;
        setSubmitting(true);
        setError(null);

        let resolution: 'donate_to_commons' | 'gift_to_member' | 'write_off_commons' | 'prune_zero_balance';
        if (preview.balance > 0) {
            resolution = hasKeyAuth && (preview.activeMembers?.length ?? 0) > 0 ? resolutionChoice : 'donate_to_commons';
        } else if (preview.balance < 0) {
            resolution = 'write_off_commons';
        } else {
            resolution = 'prune_zero_balance';
        }

        try {
            await executeOffboardApi(
                nodeUrl,
                member.publicKey,
                {
                    resolution,
                    giftRecipientPubkey: resolution === 'gift_to_member' ? giftRecipient : undefined,
                },
                adminPassword,
                tfaToken
            );
            setCompleted(true);
            onSuccess?.();
        } catch (err: any) {
            setError(err?.message || 'Failed to offboard member');
        } finally {
            submittingRef.current = false;
            setSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 overflow-y-auto bg-black/80 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-fade-in font-sans">
            <div className="m-auto bg-nature-950 border border-nature-800 rounded-3xl p-6 max-w-lg w-full space-y-6 shadow-2xl overflow-hidden relative">
                
                {/* Header */}
                <div className="flex items-start justify-between gap-3 lg:gap-0 border-b border-nature-800 pb-4">
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div className="w-10 h-10 rounded-2xl bg-red-950/60 border border-red-800/80 flex items-center justify-center text-xl">
                            🚪
                        </div>
                        <div>
                            <h3 className="text-lg font-bold text-white leading-tight">
                                Offboard Member
                            </h3>
                            <p className="text-xs text-nature-400 font-mono mt-0.5">
                                @{member.callsign} · {member.publicKey.slice(0, 10)}...
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="text-nature-400 hover:text-white p-1 rounded-lg transition-colors text-sm"
                    >
                        ✕
                    </button>
                </div>

                {/* Error Banner */}
                {error && (
                    <div className="p-3 bg-red-950/90 border border-red-800/80 rounded-2xl text-xs text-red-200">
                        ⚠️ {error}
                    </div>
                )}

                {loading ? (
                    <div className="py-12 text-center text-nature-400 text-xs font-mono">
                        Loading member financial preview...
                    </div>
                ) : completed ? (
                    <div className="space-y-4 text-xs text-center py-2">
                        <div className="w-14 h-14 rounded-full bg-emerald-950/80 border border-emerald-700 flex items-center justify-center text-3xl mx-auto text-emerald-400">
                            ✓
                        </div>
                        <div className="space-y-1">
                            <h4 className="text-base font-bold text-white">Member Offboarded</h4>
                            <p className="text-nature-300 text-xs">
                                <strong className="text-white">@{member.callsign}</strong> has been pruned from active nodes. Balances were settled with full zero-sum conservation preserved.
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={onClose}
                            className="w-full py-2.5 rounded-xl bg-nature-800 hover:bg-nature-700 text-white font-bold transition-all"
                        >
                            Close
                        </button>
                    </div>
                ) : preview ? (
                    <div className="space-y-5 text-xs">

                        {/* Sole Owner Guard */}
                        {preview.isSoleOwner && (
                            <div className="p-3 bg-amber-950/40 border border-amber-800/70 rounded-2xl text-amber-200">
                                <strong>⚠️ Sole Owner Protection:</strong> This member is the only registered owner of the node. You must appoint another owner before this account can be pruned.
                            </div>
                        )}

                        {/* Pending Escrow Warning */}
                        {preview.pendingEscrowsCount > 0 && (
                            <div className="p-3 bg-amber-950/40 border border-amber-800/70 rounded-2xl text-amber-300">
                                <strong>⚠️ Active Escrow Deals:</strong> @{member.callsign} has {preview.pendingEscrowsCount} pending escrow deal(s). Resolve disputes in the Escrow Arbitrator before offboarding.
                            </div>
                        )}

                        {/* Balance Card */}
                        <div className="p-4 bg-nature-900/80 border border-nature-800 rounded-2xl flex items-center justify-between">
                            <div>
                                <span className="text-[11px] text-nature-400 font-mono uppercase block">Departing Balance</span>
                                <span className={`text-2xl font-bold font-mono ${
                                    preview.balance > 0 ? 'text-emerald-400' : preview.balance < 0 ? 'text-red-400' : 'text-nature-200'
                                }`}>
                                    {preview.balance > 0 ? `+${preview.balance.toFixed(2)}` : preview.balance.toFixed(2)} Beans
                                </span>
                            </div>
                            <div className="text-right">
                                <span className="text-[11px] text-nature-400 font-mono uppercase block">Commons Pool</span>
                                <span className="text-lg font-bold font-mono text-nature-200">
                                    {preview.commonsBalance.toFixed(2)} Beans
                                </span>
                            </div>
                        </div>

                        {/* Case 1: Positive Balance Surplus */}
                        {preview.balance > 0 && (
                            <div className="space-y-3 bg-nature-900/50 border border-nature-800 p-4 rounded-2xl">
                                <span className="font-bold text-nature-200 block text-xs">
                                    Choose Surplus Resolution for +{preview.balance.toFixed(2)} Beans:
                                </span>

                                <label className="flex items-start gap-2.5 p-2 rounded-xl hover:bg-nature-800/40 cursor-pointer">
                                    <input
                                        type="radio"
                                        name="resolution"
                                        value="donate_to_commons"
                                        checked={resolutionChoice === 'donate_to_commons'}
                                        onChange={() => setResolutionChoice('donate_to_commons')}
                                        className="mt-0.5 text-emerald-500 focus:ring-0"
                                    />
                                    <div>
                                        <span className="font-bold text-white block">Donate to the Commons Pool</span>
                                        <span className="text-[11px] text-nature-300">
                                            Adds {preview.balance.toFixed(2)} beans to community funds (New Commons pool: {(preview.commonsBalance + preview.balance).toFixed(2)} beans).
                                        </span>
                                    </div>
                                </label>

                                <label className={`flex items-start gap-2.5 p-2 rounded-xl transition-all ${
                                    !hasKeyAuth || (preview?.activeMembers?.length ?? 0) === 0 ? 'opacity-60 cursor-not-allowed bg-nature-950/40' : 'hover:bg-nature-800/40 cursor-pointer'
                                }`}>
                                    <input
                                        type="radio"
                                        name="resolution"
                                        value="gift_to_member"
                                        disabled={!hasKeyAuth || (preview?.activeMembers?.length ?? 0) === 0}
                                        checked={hasKeyAuth && resolutionChoice === 'gift_to_member' && (preview?.activeMembers?.length ?? 0) > 0}
                                        onChange={() => {
                                            if (hasKeyAuth && (preview?.activeMembers?.length ?? 0) > 0) {
                                                setResolutionChoice('gift_to_member');
                                            }
                                        }}
                                        className="mt-0.5 text-emerald-500 focus:ring-0 disabled:opacity-50"
                                    />
                                    <div>
                                        <span className="font-bold text-white block">Gift to another community member</span>
                                        <span className="text-[11px] text-nature-300">
                                            Transfer the departing balance directly to another active member.
                                        </span>
                                        {!hasKeyAuth && (
                                            <span className="block mt-1 text-[11px] text-amber-400">
                                                ⚠️ Requires signed key-based admin authentication. Please authenticate with your admin key to enable member gifting; password-only sessions must donate departing balances to the Commons Pool.
                                            </span>
                                        )}
                                        {hasKeyAuth && (preview?.activeMembers?.length ?? 0) === 0 && (
                                            <span className="block mt-1 text-[11px] text-nature-400">
                                                No other active members available to receive a gift. Departing balance will be donated to the Commons Pool.
                                            </span>
                                        )}
                                    </div>
                                </label>

                                {resolutionChoice === 'gift_to_member' && (preview.activeMembers?.length ?? 0) > 0 && (
                                    <div className="pl-6 pt-1 space-y-2">
                                        <label className="block text-[11px] font-bold text-nature-300">
                                            Select Recipient Member:
                                        </label>
                                        <select
                                            value={giftRecipient}
                                            onChange={(e) => setGiftRecipient(e.target.value)}
                                            className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-amber-500"
                                        >
                                            {preview.activeMembers.map((m) => (
                                                <option key={m.publicKey} value={m.publicKey}>
                                                    @{m.callsign} ({m.publicKey.slice(0, 8)}...)
                                                </option>
                                            ))}
                                        </select>

                                        {isSelfDealing && (
                                            <div className="p-2.5 bg-red-950/80 border border-red-800 rounded-xl text-red-200 text-[11px] space-y-1">
                                                <strong>⚠️ Two-Person Rule Violation:</strong>
                                                <p className="m-0">
                                                    You cannot gift a departing member's balance to yourself. A different admin must execute this offboarding, or choose another recipient.
                                                </p>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Case 2: Negative Balance / Debt Write-off */}
                        {preview.balance < 0 && (
                            <div className="p-4 bg-amber-950/40 border border-amber-800/70 rounded-2xl space-y-2">
                                <span className="font-bold text-amber-200 flex items-center gap-1.5 text-xs">
                                    <span>⚠️</span> Cost to Community (Formal Debt Write-Off)
                                </span>
                                <p className="text-[11px] text-amber-300/90 leading-relaxed m-0">
                                    @{member.callsign}'s balance is <strong className="text-white font-mono">{preview.balance.toFixed(2)} beans</strong>. Offboarding will charge this debt to the Commons pool to preserve mutual credit zero-sum balance.
                                </p>
                                <div className="p-2.5 bg-black/40 border border-amber-900/60 rounded-xl text-[11px] font-mono flex justify-between">
                                    <span className="text-nature-400">Commons Pool Impact:</span>
                                    <span className="text-amber-200">
                                        {preview.commonsBalance.toFixed(2)} → {preview.projectedCommonsBalance.toFixed(2)} Beans
                                    </span>
                                </div>
                            </div>
                        )}

                        {/* Case 3: Zero Balance */}
                        {preview.balance === 0 && (
                            <div className="p-3 bg-nature-900/60 border border-nature-800 rounded-2xl text-nature-300 text-xs">
                                Balance is 0.00 Beans. No community funds or transfers required.
                            </div>
                        )}

                        {/* Action buttons */}
                        <div className="flex items-center justify-end gap-2 pt-2 border-t border-nature-800">
                            <button
                                type="button"
                                onClick={onClose}
                                className="px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-nature-200 font-semibold text-xs"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                disabled={submitting || submittingRef.current || preview.isSoleOwner || isSelfDealing || (preview.pendingEscrowsCount > 0)}
                                onClick={handleConfirmOffboard}
                                className={`px-4 py-2 rounded-xl font-bold transition-all shadow-lg text-xs ${
                                    !submitting && !submittingRef.current && !preview.isSoleOwner && !isSelfDealing && (preview.pendingEscrowsCount === 0)
                                        ? 'bg-red-600 hover:bg-red-500 text-white'
                                        : 'bg-nature-800 text-nature-500 cursor-not-allowed border border-nature-700'
                                }`}
                            >
                                {submitting || submittingRef.current ? 'Offboarding...' : 'Confirm & Prune Member'}
                            </button>
                        </div>

                    </div>
                ) : null}

            </div>
        </div>
    );
}
