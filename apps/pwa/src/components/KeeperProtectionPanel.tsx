import { useState, useEffect, useCallback } from 'react';
import type { BeanPoolIdentity } from '../lib/identity';
import {
    getRecoveryProtectionStatus,
    deriveProtectionState,
    enrolFriendKeepersApi,
    deleteAllRecoveryShares,
    getAllMembers,
    type RecoveryProtectionStatus,
} from '../lib/api';
import { resolveAvatarUrl } from '../lib/avatar';

interface Member {
    publicKey: string;
    callsign: string;
    avatarUrl?: string;
}

export interface KeeperProtectionPanelProps {
    identity: BeanPoolIdentity;
    communityName?: string;
    onProtectionChanged?: () => void;
}

export function KeeperProtectionPanel({
    identity,
    communityName,
    onProtectionChanged,
}: KeeperProtectionPanelProps) {
    const [status, setStatus] = useState<RecoveryProtectionStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Friend Picker Modal State
    const [showFriendSheet, setShowFriendSheet] = useState(false);
    const [step, setStep] = useState<1 | 2 | 3 | 4 | 5 | 6>(1);
    const [members, setMembers] = useState<Member[]>([]);
    const [loadingMembers, setLoadingMembers] = useState(false);
    const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
    const [friendError, setFriendError] = useState('');
    const [resetting, setResetting] = useState(false);

    const loadStatus = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await getRecoveryProtectionStatus();
            setStatus(res);
        } catch (e: any) {
            console.warn('[ProtectionPanel] Failed to load status:', e.message);
            setError(e.message || 'Could not load protection status');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadStatus();
    }, [loadStatus]);

    // Load community members when entering step 2 of friend picker
    useEffect(() => {
        if (showFriendSheet && step === 2 && members.length === 0 && !loadingMembers) {
            setLoadingMembers(true);
            setFriendError('');
            getAllMembers()
                .then((data) => {
                    setMembers((data as any[]).filter((m) => m.publicKey !== identity.publicKey));
                })
                .catch((e: any) => {
                    setFriendError(e.message || 'Failed to load members');
                    setStep(6);
                })
                .finally(() => {
                    setLoadingMembers(false);
                });
        }
    }, [showFriendSheet, step, members.length, loadingMembers, identity.publicKey]);

    const openFriendPicker = () => {
        setStep(1);
        setSelectedKeys(new Set());
        setFriendError('');
        setShowFriendSheet(true);
    };

    const closeFriendPicker = () => {
        setShowFriendSheet(false);
        setStep(1);
        setSelectedKeys(new Set());
        setFriendError('');
    };

    const handleToggleMember = (pubkey: string) => {
        setSelectedKeys((prev) => {
            const next = new Set(prev);
            if (next.has(pubkey)) {
                next.delete(pubkey);
            } else if (next.size < 5) {
                next.add(pubkey);
            }
            return next;
        });
    };

    const handleSplitAndProtect = async () => {
        setStep(4);
        setFriendError('');
        try {
            await enrolFriendKeepersApi(identity, Array.from(selectedKeys));
            setStep(5);
            loadStatus();
            onProtectionChanged?.();
        } catch (e: any) {
            setFriendError(e.message || 'Enrolment failed');
            setStep(6);
        }
    };

    const handleResetKeepers = async () => {
        const confirmed = window.confirm(
            'Reset Keepers?\n\n' +
            'This will delete all enrolled recovery shares from your community hub. ' +
            'Your 12-word backup seed will become the only way to recover your account until you enrol new keepers.'
        );
        if (!confirmed) return;

        setResetting(true);
        try {
            await deleteAllRecoveryShares();
            await loadStatus();
            onProtectionChanged?.();
            alert('Keepers reset successfully.');
        } catch (e: any) {
            alert('Failed to reset keepers: ' + e.message);
        } finally {
            setResetting(false);
        }
    };

    const protection = deriveProtectionState(status);
    const commLabel = communityName ? ` on ${communityName}` : '';

    return (
        <div className="bg-white dark:bg-nature-900 rounded-2xl p-5 sm:p-6 shadow-soft border border-nature-200 dark:border-nature-800 text-nature-900 dark:text-white mb-6">
            {loading ? (
                <div className="py-6 text-center text-sm text-nature-500 dark:text-nature-400 animate-pulse">
                    Checking recovery protection status...
                </div>
            ) : error ? (
                <div className="p-4 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300">
                    {error}
                </div>
            ) : protection.state === 'covered' ? (
                <div className="space-y-4">
                    <div className="flex items-center gap-2">
                        <span className="text-xl" aria-hidden="true">🛡️</span>
                        <h4 className="text-base sm:text-lg font-bold text-nature-950 dark:text-white">
                            You're covered{commLabel}
                        </h4>
                    </div>

                    <div className="space-y-2">
                        {protection.holding && protection.holding.length > 0 ? (
                            protection.holding.map((label: string, idx: number) => (
                                <div
                                    key={idx}
                                    className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl bg-emerald-50/60 dark:bg-emerald-950/30 border border-emerald-200/80 dark:border-emerald-800/50 text-xs sm:text-sm font-medium text-emerald-900 dark:text-emerald-200"
                                >
                                    <span className="text-emerald-600 dark:text-emerald-400 font-bold">✓</span>
                                    <span>{label}</span>
                                </div>
                            ))
                        ) : (
                            <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 text-xs font-medium text-emerald-800 dark:text-emerald-200">
                                <span>✓ Enrolled keepers ready</span>
                            </div>
                        )}
                    </div>

                    <p className="text-xs text-nature-600 dark:text-nature-400 leading-relaxed">
                        {protection.tier === 'friends'
                            ? 'No single piece can open your account — it takes the hub plus any 2 friends.'
                            : 'Protected by recovery keepers plus your community hub.'}
                    </p>

                    <div className="pt-2 flex flex-wrap gap-2.5">
                        <button
                            type="button"
                            onClick={openFriendPicker}
                            className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs transition-colors cursor-pointer"
                        >
                            Update Keepers
                        </button>
                        <button
                            type="button"
                            onClick={handleResetKeepers}
                            disabled={resetting}
                            className="px-3.5 py-2.5 rounded-xl border border-nature-200 dark:border-nature-700 hover:bg-nature-100 dark:hover:bg-nature-800 text-nature-600 dark:text-nature-400 font-medium text-xs transition-colors cursor-pointer"
                        >
                            {resetting ? 'Resetting...' : 'Reset Keepers'}
                        </button>
                    </div>
                </div>
            ) : protection.state === 'almost' ? (
                <div className="space-y-4">
                    <div className="flex items-center gap-2">
                        <span className="text-xl" aria-hidden="true">🔑</span>
                        <h4 className="text-base sm:text-lg font-bold text-nature-950 dark:text-white">
                            Almost there
                        </h4>
                    </div>
                    <p className="text-xs sm:text-sm text-nature-600 dark:text-nature-400 leading-relaxed">
                        You need one more keeper before your account can be split. Until then, your 12 recovery words are how you get back in.
                    </p>
                    <button
                        type="button"
                        onClick={openFriendPicker}
                        className="px-4 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs sm:text-sm transition-colors cursor-pointer"
                    >
                        🛡️ Protect with trusted friends
                    </button>
                </div>
            ) : (
                <div className="space-y-4">
                    <div className="flex items-center gap-2">
                        <span className="text-xl" aria-hidden="true">🔑</span>
                        <h4 className="text-base sm:text-lg font-bold text-nature-950 dark:text-white">
                            Your 12 words are the only way back
                        </h4>
                    </div>
                    <p className="text-xs sm:text-sm text-nature-600 dark:text-nature-400 leading-relaxed">
                        Right now these 12 words are the only way back into your account. No email, no password reset — nobody, including your hub, can restore it for you.
                    </p>
                    <div>
                        <button
                            type="button"
                            onClick={openFriendPicker}
                            className="w-full sm:w-auto px-5 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs sm:text-sm transition-colors cursor-pointer flex items-center justify-center gap-2 shadow-sm"
                        >
                            <span>🛡️ Protect with trusted friends</span>
                        </button>
                    </div>
                </div>
            )}

            {/* Friend Picker Modal */}
            {showFriendSheet && (
                <div
                    className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 sm:p-6 overflow-y-auto"
                    onClick={() => step !== 4 && closeFriendPicker()}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="friend-picker-title"
                >
                    <div
                        className="bg-white dark:bg-nature-900 rounded-2xl shadow-2xl max-w-md w-full p-5 sm:p-6 border border-nature-200 dark:border-nature-800 my-auto text-nature-900 dark:text-white"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {step === 1 && (
                            <div className="space-y-4">
                                <h3 id="friend-picker-title" className="text-base sm:text-lg font-bold text-nature-950 dark:text-white">
                                    Protect with trusted friends
                                </h3>
                                <p className="text-xs sm:text-sm text-nature-600 dark:text-nature-300 leading-relaxed">
                                    Pick at least 2 friends from your community. If you lose this device, call any 2 of them — they'll approve your recovery from their device.
                                </p>
                                <div className="p-3.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 text-xs text-amber-900 dark:text-amber-200 leading-relaxed font-medium">
                                    Note: Choose people you can actually reach by phone. They get no notification — you'll need to call them.
                                </div>
                                <div className="flex flex-col sm:flex-row gap-2.5 pt-2">
                                    <button
                                        type="button"
                                        onClick={() => setStep(2)}
                                        className="flex-1 py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs sm:text-sm transition-colors cursor-pointer"
                                    >
                                        Choose friends
                                    </button>
                                    <button
                                        type="button"
                                        onClick={closeFriendPicker}
                                        className="py-2.5 px-4 rounded-xl border border-nature-200 dark:border-nature-700 text-nature-600 dark:text-nature-400 hover:bg-nature-50 dark:hover:bg-nature-800 font-medium text-xs transition-colors cursor-pointer"
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        )}

                        {step === 2 && (
                            <div className="space-y-4">
                                <div className="flex items-center justify-between">
                                    <h3 id="friend-picker-title" className="text-base sm:text-lg font-bold text-nature-950 dark:text-white">
                                        Select friends
                                    </h3>
                                    <span className="text-xs font-bold text-emerald-600 dark:text-emerald-400">
                                        Selected: {selectedKeys.size}/5 (min 2)
                                    </span>
                                </div>

                                {loadingMembers ? (
                                    <div className="py-8 text-center flex flex-col items-center justify-center gap-2">
                                        <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                                        <p className="text-xs text-nature-500">Loading community members...</p>
                                    </div>
                                ) : members.length === 0 ? (
                                    <div className="py-6 text-center text-xs text-nature-500 dark:text-nature-400">
                                        No other members found on this community hub yet.
                                    </div>
                                ) : (
                                    <div className="max-h-60 overflow-y-auto space-y-2 pr-1">
                                        {members.map((m) => {
                                            const isSelected = selectedKeys.has(m.publicKey);
                                            const avatarSrc = resolveAvatarUrl(m.avatarUrl);
                                            return (
                                                <button
                                                    key={m.publicKey}
                                                    type="button"
                                                    onClick={() => handleToggleMember(m.publicKey)}
                                                    className={`w-full flex items-center justify-between p-3 rounded-xl border transition-all text-left cursor-pointer ${
                                                        isSelected
                                                            ? 'border-emerald-500 bg-emerald-50/60 dark:bg-emerald-950/40 text-nature-900 dark:text-white'
                                                            : 'border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-900/60 text-nature-800 dark:text-nature-200 hover:bg-nature-50 dark:hover:bg-nature-800'
                                                    }`}
                                                >
                                                    <div className="flex items-center gap-3">
                                                        <div className="w-9 h-9 rounded-full bg-emerald-100 dark:bg-emerald-900/50 flex items-center justify-center font-bold text-emerald-700 dark:text-emerald-300 overflow-hidden text-sm">
                                                            {avatarSrc ? (
                                                                <img src={avatarSrc} alt="" className="w-full h-full object-cover" />
                                                            ) : (
                                                                m.callsign?.charAt(0).toUpperCase() || '?'
                                                            )}
                                                        </div>
                                                        <span className="text-sm font-semibold">{m.callsign || 'Anonymous'}</span>
                                                    </div>
                                                    <div
                                                        className={`w-5 h-5 rounded-md border flex items-center justify-center text-xs ${
                                                            isSelected
                                                                ? 'border-emerald-600 bg-emerald-600 text-white'
                                                                : 'border-nature-300 dark:border-nature-600'
                                                        }`}
                                                    >
                                                        {isSelected && '✓'}
                                                    </div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}

                                <div className="flex gap-2.5 pt-2">
                                    <button
                                        type="button"
                                        onClick={() => setStep(1)}
                                        className="py-2.5 px-4 rounded-xl border border-nature-200 dark:border-nature-700 text-nature-600 dark:text-nature-400 hover:bg-nature-50 dark:hover:bg-nature-800 font-medium text-xs transition-colors cursor-pointer"
                                    >
                                        Back
                                    </button>
                                    <button
                                        type="button"
                                        disabled={selectedKeys.size < 2}
                                        onClick={() => setStep(3)}
                                        className="flex-1 py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-xs sm:text-sm transition-colors cursor-pointer"
                                    >
                                        Confirm Selection ({selectedKeys.size})
                                    </button>
                                </div>
                            </div>
                        )}

                        {step === 3 && (
                            <div className="space-y-4">
                                <h3 id="friend-picker-title" className="text-base sm:text-lg font-bold text-nature-950 dark:text-white">
                                    These friends will each hold a piece:
                                </h3>
                                <div className="p-3.5 rounded-xl bg-nature-50 dark:bg-nature-950/60 border border-nature-200 dark:border-nature-800 space-y-1.5">
                                    {members
                                        .filter((m) => selectedKeys.has(m.publicKey))
                                        .map((m) => (
                                            <div key={m.publicKey} className="text-xs sm:text-sm font-semibold flex items-center gap-2">
                                                <span className="text-emerald-600">🛡️</span>
                                                <span>{m.callsign || 'Anonymous'}</span>
                                            </div>
                                        ))}
                                </div>
                                <p className="text-xs text-nature-600 dark:text-nature-400 leading-relaxed">
                                    Any 2 of them plus your hub can bring you back. They cannot open your account alone.
                                </p>
                                <div className="flex gap-2.5 pt-2">
                                    <button
                                        type="button"
                                        onClick={() => setStep(2)}
                                        className="py-2.5 px-4 rounded-xl border border-nature-200 dark:border-nature-700 text-nature-600 dark:text-nature-400 hover:bg-nature-50 dark:hover:bg-nature-800 font-medium text-xs transition-colors cursor-pointer"
                                    >
                                        Back
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleSplitAndProtect}
                                        className="flex-1 py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs sm:text-sm transition-colors cursor-pointer"
                                    >
                                        Split and protect
                                    </button>
                                </div>
                            </div>
                        )}

                        {step === 4 && (
                            <div className="py-8 text-center flex flex-col items-center justify-center gap-3">
                                <div className="w-8 h-8 border-3 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                                <h4 className="text-sm sm:text-base font-bold text-nature-900 dark:text-white">
                                    Splitting your account...
                                </h4>
                                <p className="text-xs text-nature-500 dark:text-nature-400">
                                    Encrypting and distributing recovery shares to your chosen keepers.
                                </p>
                            </div>
                        )}

                        {step === 5 && (
                            <div className="space-y-4 text-center">
                                <span className="text-4xl" aria-hidden="true">✅</span>
                                <h3 id="friend-picker-title" className="text-base sm:text-lg font-bold text-emerald-600 dark:text-emerald-400">
                                    You're covered
                                </h3>
                                <p className="text-xs sm:text-sm text-nature-600 dark:text-nature-300 leading-relaxed">
                                    Your account has been split. Any 2 of your friends plus your community hub can bring you back.
                                </p>
                                <div className="p-3 rounded-xl bg-emerald-50/60 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 space-y-1 text-left">
                                    {members
                                        .filter((m) => selectedKeys.has(m.publicKey))
                                        .map((m) => (
                                            <div key={m.publicKey} className="text-xs font-semibold text-emerald-800 dark:text-emerald-300 flex items-center gap-1.5">
                                                <span>✓</span>
                                                <span>{m.callsign || 'Anonymous'}</span>
                                            </div>
                                        ))}
                                </div>
                                <button
                                    type="button"
                                    onClick={closeFriendPicker}
                                    className="w-full mt-2 py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs sm:text-sm transition-colors cursor-pointer"
                                >
                                    Done
                                </button>
                            </div>
                        )}

                        {step === 6 && (
                            <div className="space-y-4">
                                <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
                                    <span className="text-xl" aria-hidden="true">⚠️</span>
                                    <h3 id="friend-picker-title" className="text-base font-bold">
                                        Protection Setup Failed
                                    </h3>
                                </div>
                                <p className="text-xs text-red-700 dark:text-red-300 leading-relaxed">
                                    {friendError || 'An error occurred while enrolling friend keepers.'}
                                </p>
                                <div className="flex gap-2.5 pt-2">
                                    <button
                                        type="button"
                                        onClick={closeFriendPicker}
                                        className="py-2.5 px-4 rounded-xl border border-nature-200 dark:border-nature-700 text-nature-600 dark:text-nature-400 hover:bg-nature-50 dark:hover:bg-nature-800 font-medium text-xs transition-colors cursor-pointer"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setStep(2)}
                                        className="flex-1 py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs sm:text-sm transition-colors cursor-pointer"
                                    >
                                        Try Again
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

export default KeeperProtectionPanel;
