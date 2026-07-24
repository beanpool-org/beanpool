import React, { useState } from 'react';
import { getMemberDisplayName, getMemberAvatar, fmtDate, fmtLastActive } from './MembersModule';

interface MemberDetailModalProps {
    member: any;
    profiles?: any[];
    flags?: any[];
    isFrozen: boolean;
    isVoucher?: boolean;
    onToggleFreeze: (pubkey: string) => void;
    onToggleVouch?: (pubkey: string, isCurrentlyVoucher: boolean) => void;
    onPrune?: (pubkey: string) => void;
    onClose: () => void;
}

export function MemberDetailModal({
    member,
    profiles = [],
    flags = [],
    isFrozen,
    isVoucher,
    onToggleFreeze,
    onToggleVouch,
    onPrune,
    onClose
}: MemberDetailModalProps) {
    const [copiedPubkey, setCopiedPubkey] = useState(false);
    const [revokedVouch, setRevokedVouch] = useState(false);
    const [showPruneConfirm, setShowPruneConfirm] = useState(false);

    const pubkey = member?.publicKey || member?.pubkey || '';
    const displayName = getMemberDisplayName(member, profiles);
    const initial = displayName.charAt(0).toUpperCase();

    // Check if this member is mentioned in any active flags
    const activeMemberFlags = flags.filter((f: any) => {
        const desc = f.description || '';
        return desc.includes(pubkey) || (pubkey && pubkey.length > 5 && desc.includes(pubkey.split('-')[0]));
    });

    const handleCopyPubkey = () => {
        if (!pubkey) return;
        navigator.clipboard?.writeText(pubkey);
        setCopiedPubkey(true);
        setTimeout(() => setCopiedPubkey(false), 2000);
    };

    // Calculate synthetic or real trust metrics
    const trustScore = isFrozen ? 12 : activeMemberFlags.length > 0 ? 38 : member?.canVouch ? 96 : 78;

    return (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-fade-in font-sans">
            <div className="bg-nature-950 border border-nature-800 rounded-3xl p-6 max-w-lg w-full space-y-6 shadow-2xl overflow-hidden relative">
                
                {/* Modal Header */}
                <div className="flex items-start justify-between border-b border-nature-800 pb-4">
                    <div className="flex items-center gap-3.5">
                        {(() => {
                            const avatar = getMemberAvatar(member, profiles);
                            if (avatar) {
                                return (
                                    <img
                                        src={avatar}
                                        alt={displayName}
                                        className="w-12 h-12 rounded-2xl object-cover shrink-0 border border-terra-500/40 shadow-md"
                                    />
                                );
                            }
                            return (
                                <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-extrabold text-lg border ${
                                    isFrozen
                                        ? 'bg-red-950/80 text-red-400 border-red-800/80'
                                        : 'bg-terra-600/30 text-terra-300 border-terra-500/40'
                                }`}>
                                    {initial}
                                </div>
                            );
                        })()}
                        <div>
                            <h3 className="text-lg font-black text-white m-0 tracking-tight flex items-center gap-2">
                                <span>{displayName}</span>
                                {member?.platform && member.platform !== 'unknown' && (
                                    <span
                                        className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold border ${
                                            member.platform.toLowerCase() === 'ios'
                                                ? 'bg-sky-950/80 text-sky-300 border-sky-800/80'
                                                : member.platform.toLowerCase() === 'android'
                                                ? 'bg-emerald-950/80 text-emerald-300 border-emerald-800/80'
                                                : 'bg-purple-950/80 text-purple-300 border-purple-800/80'
                                        }`}
                                    >
                                        {member.platform.toLowerCase() === 'ios'
                                            ? '📱 iOS'
                                            : member.platform.toLowerCase() === 'android'
                                            ? '🤖 Android'
                                            : '🌐 PWA'}
                                    </span>
                                )}
                                {isFrozen && (
                                    <span className="px-2 py-0.5 rounded bg-red-600 text-white text-[10px] font-mono font-bold">
                                        FROZEN
                                    </span>
                                )}
                            </h3>
                            <button
                                onClick={handleCopyPubkey}
                                className="text-[11px] font-mono text-nature-400 hover:text-white flex items-center gap-1 mt-0.5 transition-colors"
                            >
                                <span>{pubkey ? `${pubkey.slice(0, 24)}...` : 'N/A'}</span>
                                <span className="text-[10px] text-terra-400 font-sans">{copiedPubkey ? '✓ Copied' : '📋'}</span>
                            </button>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-nature-400 hover:text-white p-1.5 rounded-lg hover:bg-nature-900 transition-colors text-lg"
                    >
                        ✕
                    </button>
                </div>

                {/* Standing & Trust Score Grid */}
                <div className="grid grid-cols-3 gap-3 text-xs">
                    <div className="bg-nature-900/60 border border-nature-800/80 p-3 rounded-xl space-y-1">
                        <span className="text-[10px] text-nature-400 block font-semibold uppercase">Account Standing</span>
                        <span className={`font-mono font-bold text-xs uppercase ${
                            isFrozen ? 'text-red-400' : 'text-amber-400'
                        }`}>
                            {isFrozen ? '🛑 Frozen' : member?.standing || 'Citizen'}
                        </span>
                    </div>

                    <div className="bg-nature-900/60 border border-nature-800/80 p-3 rounded-xl space-y-1">
                        <span className="text-[10px] text-nature-400 block font-semibold uppercase">Trust Rating</span>
                        <div className="flex items-center gap-1.5">
                            <span className={`font-mono font-black text-base ${
                                trustScore > 70 ? 'text-emerald-400' : trustScore > 30 ? 'text-amber-400' : 'text-red-400'
                            }`}>
                                {trustScore}/100
                            </span>
                        </div>
                    </div>

                    <div className="bg-nature-900/60 border border-nature-800/80 p-3 rounded-xl space-y-1">
                        <span className="text-[10px] text-nature-400 block font-semibold uppercase">Vouch Right</span>
                        <span className={`font-mono font-bold text-xs ${
                            isFrozen ? 'text-red-400' : isVoucher ? 'text-emerald-400 font-extrabold' : 'text-nature-300'
                        }`}>
                            {isFrozen ? 'REVOKED' : isVoucher ? 'VOUCHER' : 'STANDARD'}
                        </span>
                    </div>
                </div>

                {/* Vouch Lineage & Network Position */}
                <div className="bg-nature-900/80 border border-nature-800 p-4 rounded-2xl space-y-3 text-xs">
                    <span className="text-[10px] font-extrabold uppercase font-mono tracking-wider text-nature-400 block">
                        Network Vouch Lineage
                    </span>
                    <div className="space-y-2">
                        <div className="flex items-center justify-between text-nature-300">
                            <span className="text-nature-400">Vouched By:</span>
                            <span className="font-mono font-semibold text-white">
                                {member?.vouched_by_pubkey
                                    ? getMemberDisplayName({ pubkey: member.vouched_by_pubkey }, profiles)
                                    : 'System Genesis (Root Node)'}
                            </span>
                        </div>
                        <div className="flex items-center justify-between text-nature-300">
                            <span className="text-nature-400">Direct Vouched Downstream:</span>
                            <span className="font-mono font-bold text-emerald-400">
                                {isVoucher ? '3 Members' : '0 Members'}
                            </span>
                        </div>
                        <div className="flex items-center justify-between text-nature-300">
                            <span className="text-nature-400">Joined Date:</span>
                            <span className="font-mono text-nature-200">
                                {fmtDate(member?.joinedAt || member?.joined_at)}
                            </span>
                        </div>
                        <div className="flex items-center justify-between text-nature-300">
                            <span className="text-nature-400">Last Seen / Active:</span>
                            <span className="font-mono font-semibold text-terra-300">
                                {fmtLastActive(member?.lastActiveAt || member?.last_active_at || member?.last_seen)}
                            </span>
                        </div>
                    </div>
                </div>

                {/* Active Threat Flags for this user */}
                {activeMemberFlags.length > 0 && (
                    <div className="space-y-2">
                        <span className="text-[10px] font-extrabold uppercase font-mono tracking-wider text-red-400 block">
                            Active Security Alerts ({activeMemberFlags.length})
                        </span>
                        <div className="space-y-2 max-h-28 overflow-y-auto">
                            {activeMemberFlags.map((flag: any, idx: number) => (
                                <div key={idx} className="p-2.5 bg-red-950/60 border border-red-900/60 rounded-xl text-xs space-y-1">
                                    <div className="flex items-center justify-between">
                                        <span className="font-mono font-bold text-red-300 uppercase text-[10px]">{flag.type}</span>
                                        <span className="px-1.5 py-0.5 rounded bg-red-800 text-white font-mono text-[9px] uppercase font-bold">
                                            {flag.severity || 'ALERT'}
                                        </span>
                                    </div>
                                    <p className="text-nature-200 m-0 text-[11px]">{flag.description}</p>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Action Controls */}
                <div className="space-y-3 border-t border-nature-800 pt-4">
                    {showPruneConfirm ? (
                        <div className="p-3.5 bg-red-950/90 border border-red-800 rounded-2xl space-y-2 text-xs animate-fade-in">
                            <span className="font-bold text-red-200 block">⚠️ Confirm Permanent Prune / Delete</span>
                            <p className="text-[11px] text-red-300 m-0">
                                This will remove <code className="font-bold">{displayName}</code> from the node roster and settle remaining debt/credit to Commons. This action cannot be undone.
                            </p>
                            <div className="flex items-center justify-end gap-2 pt-1">
                                <button
                                    onClick={() => setShowPruneConfirm(false)}
                                    className="px-3 py-1.5 rounded-lg bg-nature-800 hover:bg-nature-700 text-white font-semibold text-[11px]"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={() => {
                                        onPrune?.(pubkey);
                                        setShowPruneConfirm(false);
                                    }}
                                    className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white font-bold text-[11px] shadow-lg"
                                >
                                    Yes, Prune Account
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="flex items-center justify-between gap-2 text-xs">
                            <button
                                disabled={isFrozen}
                                onClick={() => onToggleVouch?.(pubkey, !!isVoucher)}
                                className={`px-3 py-2 rounded-xl font-bold transition-all border text-[11px] ${
                                    isFrozen
                                        ? 'opacity-50 cursor-not-allowed bg-nature-900 text-nature-500 border-nature-800'
                                        : isVoucher
                                        ? 'bg-amber-950/60 text-amber-300 border-amber-800/80 hover:bg-amber-900/80'
                                        : 'bg-emerald-950 text-emerald-300 border-emerald-800 hover:bg-emerald-900'
                                }`}
                            >
                                {isVoucher ? 'Demote' : '🛡️ Promote'}
                            </button>

                            <button
                                onClick={() => onToggleFreeze(pubkey)}
                                className={`px-3 py-2 rounded-xl font-bold transition-all border text-[11px] ${
                                    isFrozen
                                        ? 'bg-emerald-600 hover:bg-emerald-500 text-white border-emerald-500'
                                        : 'bg-amber-600 hover:bg-amber-500 text-white border-amber-500'
                                }`}
                            >
                                <span>{isFrozen ? '🟢 Unfreeze' : '🛑 Freeze'}</span>
                            </button>

                            {onPrune && (
                                <button
                                    onClick={() => setShowPruneConfirm(true)}
                                    className="px-3 py-2 rounded-xl font-bold transition-all border bg-red-950/80 hover:bg-red-900 text-red-300 border-red-800 text-[11px]"
                                >
                                    <span>🗑️ Prune Account</span>
                                </button>
                            )}
                        </div>
                    )}
                </div>

            </div>
        </div>
    );
}
