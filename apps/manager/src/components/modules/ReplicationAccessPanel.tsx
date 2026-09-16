import React, { useState, useEffect, useCallback } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import {
    getReplicationAccess,
    generateReplicationToken,
    setReplicationTokenMode,
    clearReplicationToken,
    getTfaSessionToken,
    type ReplicationAccessData,
    type ReplicationAccessEvent,
} from '../../lib/node-client';

export interface ReplicationAccessPanelProps {
    activeNode: NodeProfile;
    initialData?: ReplicationAccessData;
    onRefreshDiag?: () => void;
}

function formatRelativeTime(dateVal: string | number | null | undefined): string {
    if (!dateVal) return 'never';
    try {
        const d = new Date(dateVal);
        if (isNaN(d.getTime())) return typeof dateVal === 'string' ? dateVal : 'never';
        const diffMs = Date.now() - d.getTime();
        const diffSec = Math.round(diffMs / 1000);
        if (diffSec < 5) return 'just now';
        if (diffSec < 60) return `${diffSec}s ago`;
        const diffMin = Math.round(diffSec / 60);
        if (diffMin < 60) return `${diffMin}m ago`;
        const diffHr = Math.round(diffMin / 60);
        if (diffHr < 24) return `${diffHr}h ago`;
        const diffDay = Math.round(diffHr / 24);
        return `${diffDay}d ago`;
    } catch {
        return 'never';
    }
}

export function ReplicationAccessPanel({
    activeNode,
    initialData,
    onRefreshDiag,
}: ReplicationAccessPanelProps) {
    const [accessData, setAccessData] = useState<ReplicationAccessData | null>(initialData || null);
    const [loading, setLoading] = useState(false);
    const [statusMsg, setStatusMsg] = useState<{ text: string; isError: boolean } | null>(null);

    // Newly generated token revealed once
    const [revealedToken, setRevealedToken] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    // Modals
    const [showGenConfirm, setShowGenConfirm] = useState(false);
    const [showClearConfirm, setShowClearConfirm] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [clearing, setClearing] = useState(false);
    const [updatingMode, setUpdatingMode] = useState(false);

    const loadData = useCallback(async () => {
        if (initialData && !activeNode?.url) return;
        setLoading(true);
        try {
            const tfa = getTfaSessionToken(activeNode.id);
            const data = await getReplicationAccess(
                activeNode.url,
                activeNode.adminPassword,
                tfa
            );
            setAccessData(data);
        } catch (err: unknown) {
            console.warn('Failed to load replication access:', err);
        } finally {
            setLoading(false);
        }
    }, [activeNode.id, activeNode.url, activeNode.adminPassword, initialData]);

    useEffect(() => {
        if (initialData) {
            setAccessData(initialData);
        } else {
            loadData();
        }
    }, [initialData, loadData]);

    const handleConfirmGenerate = async () => {
        setGenerating(true);
        setStatusMsg(null);
        try {
            const tfa = getTfaSessionToken(activeNode.id);
            const res = await generateReplicationToken(
                activeNode.url,
                activeNode.adminPassword,
                tfa
            );
            if (res.token) {
                setRevealedToken(res.token);
                setCopied(false);
                setShowGenConfirm(false);
                setStatusMsg({
                    text: 'Token generated — copy it now. Paste it into each backup replica.',
                    isError: false,
                });
                setAccessData((prev) => ({
                    ...prev,
                    hasToken: true,
                }));
                onRefreshDiag?.();
            }
        } catch (err: unknown) {
            setStatusMsg({
                text: err instanceof Error ? err.message : String(err),
                isError: true,
            });
        } finally {
            setGenerating(false);
        }
    };

    const handleConfirmClear = async () => {
        setClearing(true);
        setStatusMsg(null);
        try {
            const tfa = getTfaSessionToken(activeNode.id);
            await clearReplicationToken(
                activeNode.url,
                activeNode.adminPassword,
                tfa
            );
            setShowClearConfirm(false);
            setRevealedToken(null);
            setStatusMsg({
                text: 'Replication token cleared. Replicas now require admin password.',
                isError: false,
            });
            setAccessData((prev) => ({
                ...prev,
                hasToken: false,
                tokenOnly: false,
            }));
            onRefreshDiag?.();
        } catch (err: unknown) {
            setStatusMsg({
                text: err instanceof Error ? err.message : String(err),
                isError: true,
            });
        } finally {
            setClearing(false);
        }
    };

    const handleToggleTokenOnly = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const nextTokenOnly = e.target.checked;
        if (nextTokenOnly && !accessData?.hasToken) {
            setStatusMsg({
                text: 'Generate a replication token before enabling token-only mode.',
                isError: true,
            });
            return;
        }

        setUpdatingMode(true);
        setStatusMsg(null);
        try {
            const tfa = getTfaSessionToken(activeNode.id);
            await setReplicationTokenMode(
                activeNode.url,
                nextTokenOnly,
                activeNode.adminPassword,
                tfa
            );
            setAccessData((prev) => ({
                ...prev,
                tokenOnly: nextTokenOnly,
            }));
            setStatusMsg({
                text: nextTokenOnly
                    ? 'Token-only enforced — admin-password pulls now rejected.'
                    : 'Admin-password fallback re-enabled.',
                isError: false,
            });
            onRefreshDiag?.();
        } catch (err: unknown) {
            setStatusMsg({
                text: err instanceof Error ? err.message : String(err),
                isError: true,
            });
        } finally {
            setUpdatingMode(false);
        }
    };

    const handleCopyToken = () => {
        if (!revealedToken) return;
        navigator.clipboard.writeText(revealedToken)
            .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 3000);
            })
            .catch((err) => {
                console.error('Failed to copy replication token:', err);
                setStatusMsg({
                    text: 'Failed to copy to clipboard. Please select and copy the token manually.',
                    isError: true,
                });
            });
    };

    useEffect(() => {
        if (!showGenConfirm && !showClearConfirm) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !generating && !clearing) {
                e.preventDefault();
                setShowGenConfirm(false);
                setShowClearConfirm(false);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [showGenConfirm, showClearConfirm, generating, clearing]);

    const hasToken = Boolean(accessData?.hasToken);
    const tokenOnly = Boolean(accessData?.tokenOnly);

    // Compute token state display text safely
    const tokenStateText = hasToken
        ? tokenOnly
            ? 'set · token-only enforced'
            : 'set · admin-password fallback active'
        : 'not set (admin password in use)';

    // Compute last pull text safely
    const lastPullAtStr = typeof accessData?.lastPullAt === 'string' ? accessData.lastPullAt : null;
    const lastPullIpStr = typeof accessData?.lastPullIp === 'string' ? accessData.lastPullIp : null;
    const lastPullAuthStr = typeof accessData?.lastPullAuth === 'string' ? accessData.lastPullAuth : null;
    const lastPullDisplay = lastPullAtStr
        ? `${formatRelativeTime(lastPullAtStr)}${lastPullIpStr ? ' · ' + lastPullIpStr : ''}${lastPullAuthStr ? ' · ' + lastPullAuthStr : ''}`
        : 'never';

    // Compute total pulls safely
    const totalPullsDisplay = typeof accessData?.totalPulls === 'number'
        ? String(accessData.totalPulls)
        : '0';

    // Compute rejected count safely
    const totalRejected = typeof accessData?.totalRejected === 'number' ? accessData.totalRejected : 0;
    const lastRejectedAtStr = typeof accessData?.lastRejectedAt === 'string' ? accessData.lastRejectedAt : null;
    const rejectedDisplay = totalRejected > 0
        ? `${totalRejected}${lastRejectedAtStr ? ' · last ' + formatRelativeTime(lastRejectedAtStr) : ''}`
        : '0';

    // Compute recent events safely
    const recentEvents: ReplicationAccessEvent[] = Array.isArray(accessData?.recent)
        ? accessData.recent
        : [];

    return (
        <div
            id="replication-access-panel"
            className="p-4 sm:p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-6 font-sans"
        >
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-nature-800 pb-4">
                <div>
                    <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                        <span>🔑</span>
                        <span>Replication Access</span>
                        <span className="text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-full bg-sky-500/20 text-sky-300 border border-sky-500/30">
                            primary
                        </span>
                    </h3>
                    <p className="text-xs text-nature-400 m-0 mt-1 max-w-2xl leading-relaxed">
                        The snapshot-pull endpoint serves this node&apos;s <strong>entire ledger</strong>.
                        Authenticate backups with a dedicated <strong>replication token</strong> — a scoped,
                        read-only credential separate from the admin password, so the admin password can rotate
                        without breaking replication and a leaked admin password cannot be used to siphon the database.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={loadData}
                        disabled={loading}
                        className="min-h-[44px] px-3 py-1.5 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-semibold text-white border border-nature-700 transition-all disabled:opacity-50 flex items-center gap-1.5"
                        title="Refresh replication access"
                    >
                        <span className={loading ? 'animate-spin' : ''}>🔄</span>
                        <span className="hidden sm:inline">Refresh</span>
                    </button>
                </div>
            </div>

            {/* Status Message */}
            {statusMsg && (
                <div
                    id="rep-token-status"
                    role={statusMsg.isError ? 'alert' : 'status'}
                    className={`p-3 rounded-xl border text-xs font-semibold ${
                        statusMsg.isError
                            ? 'bg-red-950 border-red-800 text-red-200'
                            : 'bg-emerald-950 border-emerald-800 text-emerald-300'
                    }`}
                >
                    {statusMsg.isError ? '❌ ' : '✓ '}
                    {statusMsg.text}
                </div>
            )}

            {/* Token Management Card */}
            <div className="bg-nature-950/70 p-4 sm:p-5 rounded-xl border border-nature-800 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 flex-wrap">
                    <div className="text-xs text-nature-300">
                        Replication token:{' '}
                        <strong
                            id="rep-token-state"
                            className={`font-semibold ml-1 ${
                                hasToken ? 'text-emerald-400' : 'text-amber-400'
                            }`}
                        >
                            {tokenStateText}
                        </strong>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                        {hasToken && (
                            <button
                                type="button"
                                id="rep-token-clear-btn"
                                onClick={() => setShowClearConfirm(true)}
                                className="min-h-[44px] px-3 py-1.5 rounded-xl bg-nature-800 hover:bg-red-950/60 hover:text-red-300 text-xs font-semibold text-nature-400 border border-nature-700 transition-all"
                            >
                                Remove Token
                            </button>
                        )}
                        <button
                            type="button"
                            id="rep-token-gen-btn"
                            onClick={() => setShowGenConfirm(true)}
                            className="min-h-[44px] px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all shadow-sm flex items-center gap-1.5"
                        >
                            <span>🔑</span>
                            <span>Generate / rotate token</span>
                        </button>
                    </div>
                </div>

                {/* Require Token Toggle */}
                <label className="flex items-start sm:items-center gap-3 text-xs text-nature-200 cursor-pointer pt-2 border-t border-nature-800/60 min-h-[44px]">
                    <input
                        type="checkbox"
                        id="rep-token-only"
                        checked={tokenOnly}
                        onChange={handleToggleTokenOnly}
                        disabled={updatingMode}
                        className="mt-0.5 sm:mt-0 w-4 h-4 rounded text-nature-600 focus:ring-nature-500 cursor-pointer disabled:opacity-50"
                    />
                    <span className="leading-snug">
                        Require token — reject admin-password pulls{' '}
                        <span className="text-nature-400 font-normal">
                            (enable only after the token is set on every backup)
                        </span>
                    </span>
                </label>

                {/* Newly Generated Token Reveal Box */}
                {revealedToken && (
                    <div
                        id="rep-token-reveal"
                        className="p-4 rounded-xl bg-amber-950/40 border border-amber-800/80 space-y-3"
                    >
                        <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-bold text-amber-300 flex items-center gap-1.5">
                                <span>⚠️</span>
                                <span>Copy this token now — it is shown only once. Paste it into each backup&apos;s connection settings.</span>
                            </span>
                            <button
                                type="button"
                                onClick={() => setRevealedToken(null)}
                                className="text-xs text-nature-400 hover:text-white p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg hover:bg-nature-800/50 transition-colors"
                                title="Dismiss reveal"
                                aria-label="Dismiss revealed token"
                            >
                                ✕
                            </button>
                        </div>
                        <div className="relative bg-black/70 border border-nature-700 rounded-lg p-3 pr-24 font-mono text-xs text-white break-all select-all">
                            <code id="rep-token-value">{revealedToken}</code>
                            <button
                                type="button"
                                id="copy-rep-token-btn"
                                onClick={handleCopyToken}
                                className="min-h-[36px] absolute top-2 right-2 px-3 py-1 rounded bg-nature-800 hover:bg-nature-700 text-xs font-semibold text-white border border-nature-600 transition-all flex items-center gap-1"
                                title="Copy token"
                            >
                                {copied ? '✓ Copied' : '📋 Copy'}
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* Snapshot Pull Activity Audit Card */}
            <div className="bg-nature-950/70 p-4 sm:p-5 rounded-xl border border-nature-800 space-y-4">
                <div className="border-b border-nature-800/80 pb-2 flex items-center justify-between">
                    <h4 className="text-xs font-extrabold uppercase tracking-wider text-nature-400 m-0">
                        Snapshot Pull Activity
                    </h4>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="bg-nature-900/60 p-3.5 rounded-xl border border-nature-800/80 space-y-1">
                        <span className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400 block">
                            Last Pull
                        </span>
                        <span
                            id="rep-last-pull"
                            className="text-xs font-mono font-bold text-white block truncate"
                        >
                            {lastPullDisplay}
                        </span>
                    </div>

                    <div className="bg-nature-900/60 p-3.5 rounded-xl border border-nature-800/80 space-y-1">
                        <span className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400 block">
                            Total Pulls
                        </span>
                        <span
                            id="rep-total-pulls"
                            className="text-xs font-mono font-bold text-white block"
                        >
                            {totalPullsDisplay}
                        </span>
                    </div>

                    <div className="bg-nature-900/60 p-3.5 rounded-xl border border-nature-800/80 space-y-1">
                        <span className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400 block">
                            Rejected Attempts
                        </span>
                        <span
                            id="rep-rejected"
                            className={`text-xs font-mono font-bold block ${
                                totalRejected > 0 ? 'text-red-400' : 'text-white'
                            }`}
                        >
                            {rejectedDisplay}
                        </span>
                    </div>
                </div>

                {/* Recent Pull Activity Log */}
                <div id="rep-recent" className="space-y-1.5 pt-2">
                    {recentEvents.length > 0 && (
                        <>
                            <span className="text-[10px] font-extrabold uppercase tracking-wider text-nature-500 block">
                                Recent Events ({recentEvents.length})
                            </span>
                            <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
                                {recentEvents.slice(0, 6).map((ev, idx) => {
                                    const isOk = ev.auth !== 'rejected';
                                    return (
                                        <div
                                            key={idx}
                                            className="flex items-center justify-between text-xs py-1 px-2 rounded bg-nature-900/40 border border-nature-800/50"
                                        >
                                            <span
                                                className={`font-mono text-[11px] font-semibold ${
                                                    isOk ? 'text-emerald-400' : 'text-red-400'
                                                }`}
                                            >
                                                {isOk
                                                    ? ev.auth
                                                    : `rejected${ev.reason ? ` (${ev.reason})` : ''}`}
                                            </span>
                                            <span className="text-nature-400 text-[11px]">
                                                {ev.ip || '—'} · {formatRelativeTime(ev.at)}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        </>
                    )}
                </div>

                <p className="text-[11px] text-nature-400 m-0 pt-1 leading-relaxed">
                    Rejected attempts are pulls with a bad/missing credential. A nonzero count from an unexpected source is worth investigating.
                </p>
            </div>

            {/* Confirmation Modal: Generate Token */}
            {showGenConfirm && (
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="gen-token-title"
                    className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
                    onClick={(e) => {
                        if (e.target === e.currentTarget && !generating) setShowGenConfirm(false);
                    }}
                >
                    <div className="bg-nature-900 border border-nature-700 rounded-2xl p-6 max-w-md w-full shadow-2xl space-y-4 font-sans text-white">
                        <div className="flex items-start justify-between gap-3 border-b border-nature-800 pb-3">
                            <div className="flex items-center gap-3 text-amber-400">
                                <span className="text-2xl">⚠️</span>
                                <h3 id="gen-token-title" className="text-base font-bold m-0 text-white">
                                    Generate / Rotate Replication Token?
                                </h3>
                            </div>
                            <button
                                type="button"
                                onClick={() => { if (!generating) setShowGenConfirm(false); }}
                                disabled={generating}
                                className="text-nature-400 hover:text-white p-1 text-sm min-h-[44px] min-w-[44px] flex items-center justify-center disabled:opacity-50"
                                aria-label="Close generate confirmation"
                            >
                                ✕
                            </button>
                        </div>
                        <p className="text-xs text-nature-300 leading-relaxed m-0">
                            Any existing replication token stops working immediately. You will need to paste the new token into every standby backup server&apos;s connection configuration.
                        </p>
                        <div className="flex items-center justify-end gap-3 pt-2">
                            <button
                                type="button"
                                onClick={() => setShowGenConfirm(false)}
                                disabled={generating}
                                className="min-h-[44px] px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white transition-all disabled:opacity-50"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                id="confirm-gen-token-btn"
                                onClick={handleConfirmGenerate}
                                disabled={generating}
                                className="min-h-[44px] px-5 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-600 transition-all disabled:opacity-50 flex items-center gap-2"
                            >
                                {generating ? (
                                    <>
                                        <span className="animate-spin text-sm">🔄</span>
                                        <span>Generating...</span>
                                    </>
                                ) : (
                                    <span>🔑 Generate Token</span>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Confirmation Modal: Clear Token */}
            {showClearConfirm && (
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="clear-token-title"
                    className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
                    onClick={(e) => {
                        if (e.target === e.currentTarget && !clearing) setShowClearConfirm(false);
                    }}
                >
                    <div className="bg-nature-900 border border-nature-700 rounded-2xl p-6 max-w-md w-full shadow-2xl space-y-4 font-sans text-white">
                        <div className="flex items-start justify-between gap-3 border-b border-nature-800 pb-3">
                            <div className="flex items-center gap-3 text-red-400">
                                <span className="text-2xl">🗑️</span>
                                <h3 id="clear-token-title" className="text-base font-bold m-0 text-white">
                                    Remove Replication Token?
                                </h3>
                            </div>
                            <button
                                type="button"
                                onClick={() => { if (!clearing) setShowClearConfirm(false); }}
                                disabled={clearing}
                                className="text-nature-400 hover:text-white p-1 text-sm min-h-[44px] min-w-[44px] flex items-center justify-center disabled:opacity-50"
                                aria-label="Close clear confirmation"
                            >
                                ✕
                            </button>
                        </div>
                        <p className="text-xs text-nature-300 leading-relaxed m-0">
                            Removing the token turns off token authentication. Replicas will only be able to authenticate using the master admin password if token-only mode is disabled.
                        </p>
                        <div className="flex items-center justify-end gap-3 pt-2">
                            <button
                                type="button"
                                onClick={() => setShowClearConfirm(false)}
                                disabled={clearing}
                                className="min-h-[44px] px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white transition-all disabled:opacity-50"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                id="confirm-clear-token-btn"
                                onClick={handleConfirmClear}
                                disabled={clearing}
                                className="min-h-[44px] px-5 py-2 rounded-xl bg-red-800 hover:bg-red-700 text-xs font-bold text-white border border-red-600 transition-all disabled:opacity-50 flex items-center gap-2"
                            >
                                {clearing ? (
                                    <>
                                        <span className="animate-spin text-sm">🔄</span>
                                        <span>Removing...</span>
                                    </>
                                ) : (
                                    <span>Remove Token</span>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
