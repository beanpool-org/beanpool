import React, { useState, useEffect, useCallback } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { resolveNodeApiUrl, buildAdminHeaders, getTfaSessionToken } from '../../lib/node-client';

export interface StandbyReplicationPanelProps {
    activeNode: NodeProfile;
    onRefreshDiag?: () => void;
}

export interface BackupStatusData {
    role?: 'primary' | 'backup' | string;
    primaryUrl?: string | null;
    intervalMs?: number;
    lastSuccess?: number | string | null;
    failStreak?: number;
    lastError?: string | null;
    isSynced?: boolean;
    consistency?: {
        match?: boolean;
        checkedAt?: number | string;
        details?: string;
        [key: string]: unknown;
    } | null;
    [key: string]: unknown;
}

export function StandbyReplicationPanel({
    activeNode,
    onRefreshDiag,
}: StandbyReplicationPanelProps) {
    const [statusData, setStatusData] = useState<BackupStatusData | null>(null);
    const [loadingStatus, setLoadingStatus] = useState(false);
    const [primaryUrl, setPrimaryUrl] = useState('');
    const [primaryPassword, setPrimaryPassword] = useState('');
    const [primaryToken, setPrimaryToken] = useState('');
    const [hasExistingPassword, setHasExistingPassword] = useState(false);
    const [hasExistingToken, setHasExistingToken] = useState(false);
    const [savingConfig, setSavingConfig] = useState(false);
    const [configMsg, setConfigMsg] = useState<{ text: string; isError: boolean } | null>(null);

    // Resync confirmation modal state
    const [showResyncConfirm, setShowResyncConfirm] = useState(false);
    const [resyncing, setResyncing] = useState(false);
    const [resyncMsg, setResyncMsg] = useState<{ text: string; isError: boolean } | null>(null);

    const loadData = useCallback(async () => {
        setLoadingStatus(true);
        try {
            const headers = buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id));

            // 1. Fetch live backup status
            const statusUrl = resolveNodeApiUrl(activeNode.url, '/api/local/admin/backup-status');
            const statusRes = await fetch(statusUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify({ password: activeNode.adminPassword }),
            }).catch(() => null);

            if (statusRes && statusRes.ok) {
                const data = await statusRes.json().catch(() => ({}));
                setStatusData(data);
                if (data.primaryUrl && typeof data.primaryUrl === 'string') {
                    setPrimaryUrl(data.primaryUrl);
                }
            }

            // 2. Fetch replication config secrets state
            const configUrl = resolveNodeApiUrl(activeNode.url, '/api/local/admin/replication-config/get');
            const configRes = await fetch(configUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify({ password: activeNode.adminPassword }),
            }).catch(() => null);

            if (configRes && configRes.ok) {
                const cfg = await configRes.json().catch(() => ({}));
                if (cfg.primaryUrl && typeof cfg.primaryUrl === 'string') {
                    setPrimaryUrl(cfg.primaryUrl);
                }
                setHasExistingPassword(Boolean(cfg.hasPassword));
                setHasExistingToken(Boolean(cfg.hasToken));
            }
        } catch (err: unknown) {
            console.warn('Failed to load backup status or replication config:', err);
        } finally {
            setLoadingStatus(false);
        }
    }, [activeNode.id, activeNode.url, activeNode.adminPassword]);

    useEffect(() => {
        loadData();
    }, [loadData]);

    const handleSaveConfig = async (e: React.FormEvent) => {
        e.preventDefault();
        setSavingConfig(true);
        setConfigMsg(null);
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/replication-config/save');
            const body: Record<string, unknown> = {
                password: activeNode.adminPassword,
                primaryUrl: primaryUrl.trim(),
            };
            if (primaryPassword) {
                body.primaryPassword = primaryPassword;
            }
            if (primaryToken !== undefined && primaryToken !== '') {
                body.primaryToken = primaryToken.trim();
            } else if (hasExistingToken && primaryToken === '') {
                body.primaryToken = '';
            }

            const res = await fetch(url, {
                method: 'POST',
                headers: buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.success) {
                setConfigMsg({ text: 'Replication configuration saved successfully.', isError: false });
                setPrimaryPassword('');
                setPrimaryToken('');
                setHasExistingPassword(true);
                if (body.primaryToken === '') {
                    setHasExistingToken(false);
                } else if (primaryToken.trim()) {
                    setHasExistingToken(true);
                }
                loadData();
                onRefreshDiag?.();
            } else {
                setConfigMsg({ text: data.error || 'Failed to save replication configuration', isError: true });
            }
        } catch (err: unknown) {
            setConfigMsg({ text: err instanceof Error ? err.message : String(err), isError: true });
        } finally {
            setSavingConfig(false);
        }
    };

    const handleConfirmResync = async () => {
        setResyncing(true);
        setResyncMsg(null);
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/replication-resync');
            const res = await fetch(url, {
                method: 'POST',
                headers: buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
                body: JSON.stringify({ password: activeNode.adminPassword }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.success) {
                setResyncMsg({ text: 'Resync complete: replica database rebuilt from primary snapshot.', isError: false });
                setShowResyncConfirm(false);
                loadData();
                onRefreshDiag?.();
            } else {
                setResyncMsg({ text: data.error || 'Resync failed', isError: true });
            }
        } catch (err: unknown) {
            setResyncMsg({ text: err instanceof Error ? err.message : String(err), isError: true });
        } finally {
            setResyncing(false);
        }
    };

    const role = typeof statusData?.role === 'string' ? statusData.role.toLowerCase() : 'primary';
    const isStandby = role === 'backup';
    const lastSuccessStr = statusData?.lastSuccess
        ? new Date(statusData.lastSuccess).toLocaleString()
        : 'Never';
    const failStreak = typeof statusData?.failStreak === 'number' ? statusData.failStreak : 0;
    const intervalSec = statusData?.intervalMs ? Math.round(statusData.intervalMs / 1000) : 60;

    return (
        <div className="p-4 sm:p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-6 font-sans">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-nature-800 pb-4">
                <div>
                    <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                        <span>🔄</span>
                        <span>Live Backup Server &amp; Hot-Standby Replication</span>
                    </h3>
                    <p className="text-xs text-nature-400 m-0 mt-0.5">
                        High-availability standby failover. Replicas pull signed read-only snapshots from the primary node.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <span
                        id="backup-role-badge"
                        className={`px-3 py-1 rounded-full text-xs font-bold font-mono uppercase ${
                            isStandby
                                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                                : 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                        }`}
                    >
                        {isStandby ? 'Standby Replica' : 'Primary Node'}
                    </span>
                    <button
                        type="button"
                        onClick={loadData}
                        disabled={loadingStatus}
                        className="px-3 py-1.5 rounded-lg bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white transition-all min-h-[36px]"
                    >
                        {loadingStatus ? '...' : '🔄 Refresh'}
                    </button>
                </div>
            </div>

            {/* Health & Sync Telemetry Card */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="bg-nature-950 p-4 rounded-xl border border-nature-800 space-y-1">
                    <span className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400 block">
                        Replication Health
                    </span>
                    <div className="flex items-center gap-2">
                        <span
                            id="backup-health-badge"
                            className={`px-2 py-0.5 rounded text-xs font-bold ${
                                failStreak === 0 && statusData?.lastSuccess
                                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                                    : failStreak > 0
                                        ? 'bg-red-500/20 text-red-300 border border-red-500/30'
                                        : 'bg-nature-800 text-nature-400'
                            }`}
                        >
                            {failStreak === 0 && statusData?.lastSuccess ? '🟢 Healthy' : failStreak > 0 ? `⚠️ Diverged (${failStreak} fails)` : 'Idle'}
                        </span>
                    </div>
                </div>

                <div className="bg-nature-950 p-4 rounded-xl border border-nature-800 space-y-1">
                    <span className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400 block">
                        Last Successful Pull
                    </span>
                    <span id="backup-last-success" className="text-xs font-mono font-bold text-white block truncate">
                        {lastSuccessStr}
                    </span>
                </div>

                <div className="bg-nature-950 p-4 rounded-xl border border-nature-800 space-y-1">
                    <span className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400 block">
                        Pull Interval
                    </span>
                    <span id="backup-interval" className="text-xs font-mono font-bold text-white block">
                        Every {intervalSec}s
                    </span>
                </div>
            </div>

            {/* Resync Status Messages */}
            {resyncMsg && (
                <div
                    role={resyncMsg.isError ? 'alert' : 'status'}
                    className={`p-3 rounded-xl border text-xs font-semibold ${
                        resyncMsg.isError
                            ? 'bg-red-950 border-red-800 text-red-200'
                            : 'bg-emerald-950 border-emerald-800 text-emerald-300'
                    }`}
                >
                    {resyncMsg.isError ? '❌ ' : '✓ '}
                    {resyncMsg.text}
                </div>
            )}

            {/* Connection Configuration Form */}
            <form onSubmit={handleSaveConfig} className="bg-nature-950/70 p-4 sm:p-5 rounded-xl border border-nature-800 space-y-4">
                <div className="border-b border-nature-800/80 pb-2">
                    <h4 className="text-sm font-bold text-white m-0">Replication Connection Configuration</h4>
                    <p className="text-[11px] text-nature-400 m-0 mt-0.5">
                        Configure this standby replica to continuously synchronize with the primary appliance.
                    </p>
                </div>

                {configMsg && (
                    <div
                        role={configMsg.isError ? 'alert' : 'status'}
                        className={`p-3 rounded-xl border text-xs font-semibold ${
                            configMsg.isError
                                ? 'bg-red-950 border-red-800 text-red-200'
                                : 'bg-emerald-950 border-emerald-800 text-emerald-300'
                        }`}
                    >
                        {configMsg.isError ? '❌ ' : '✓ '}
                        {configMsg.text}
                    </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="sm:col-span-2">
                        <label htmlFor="rep-primary-url" className="block text-xs font-bold text-nature-300 mb-1">
                            Primary Node HTTPS URL
                        </label>
                        <input
                            id="rep-primary-url"
                            type="url"
                            value={primaryUrl}
                            onChange={(e) => setPrimaryUrl(e.target.value)}
                            placeholder="https://test.beanpool.org"
                            className="w-full bg-nature-900 border border-nature-700 rounded-xl px-3.5 py-2 text-xs text-white font-mono focus:outline-none focus:border-terra-500 min-h-[44px]"
                        />
                    </div>

                    <div>
                        <label htmlFor="rep-primary-pw" className="block text-xs font-bold text-nature-300 mb-1">
                            Primary Admin Password
                        </label>
                        <input
                            id="rep-primary-pw"
                            type="password"
                            value={primaryPassword}
                            onChange={(e) => setPrimaryPassword(e.target.value)}
                            placeholder={hasExistingPassword ? '•••••••• (Leave blank to keep current)' : 'Enter primary admin password'}
                            autoComplete="off"
                            className="w-full bg-nature-900 border border-nature-700 rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none focus:border-terra-500 min-h-[44px]"
                        />
                    </div>

                    <div>
                        <label htmlFor="rep-primary-token" className="block text-xs font-bold text-nature-300 mb-1">
                            Primary Replication Token <span className="text-emerald-400 font-normal">(Scoped, recommended)</span>
                        </label>
                        <input
                            id="rep-primary-token"
                            type="password"
                            value={primaryToken}
                            onChange={(e) => setPrimaryToken(e.target.value)}
                            placeholder={hasExistingToken ? '•••••••• (Leave blank to keep current)' : 'Paste scoped replication token'}
                            autoComplete="off"
                            className="w-full bg-nature-900 border border-nature-700 rounded-xl px-3.5 py-2 text-xs text-white font-mono focus:outline-none focus:border-terra-500 min-h-[44px]"
                        />
                    </div>
                </div>

                <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-2">
                    <button
                        type="submit"
                        id="save-rep-config-btn"
                        disabled={savingConfig}
                        className="min-h-[44px] px-5 py-2 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all disabled:opacity-50"
                    >
                        {savingConfig ? 'Saving...' : 'Save Connection'}
                    </button>

                    {/* Resync Trigger */}
                    {isStandby && (
                        <button
                            type="button"
                            id="backup-resync-btn"
                            onClick={() => setShowResyncConfirm(true)}
                            className="min-h-[44px] px-4 py-2 rounded-xl bg-amber-950/70 hover:bg-amber-900 border border-amber-800 text-amber-200 text-xs font-bold transition-all flex items-center justify-center gap-1.5"
                        >
                            <span>🔄</span>
                            <span>Force Full Resync</span>
                        </button>
                    )}
                </div>
            </form>

            {/* Resync Confirmation Modal */}
            {isStandby && showResyncConfirm && (
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="resync-dialog-title"
                    className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in"
                    onClick={(e) => {
                        if (e.target === e.currentTarget) setShowResyncConfirm(false);
                    }}
                >
                    <div className="bg-nature-900 border border-amber-700 rounded-2xl p-6 max-w-md w-full shadow-2xl space-y-4 font-sans text-white">
                        <div className="flex items-start justify-between gap-3 border-b border-nature-800 pb-3">
                            <h3 id="resync-dialog-title" className="text-base font-bold text-amber-300 flex items-center gap-2 m-0">
                                <span>⚠️</span>
                                <span>Confirm Full Replication Resync</span>
                            </h3>
                            <button
                                type="button"
                                onClick={() => setShowResyncConfirm(false)}
                                className="text-nature-400 hover:text-white p-1 text-sm min-h-[44px] min-w-[44px] flex items-center justify-center"
                                aria-label="Close resync confirmation"
                            >
                                ✕
                            </button>
                        </div>

                        <div className="p-3 bg-amber-950/60 border border-amber-900/60 rounded-xl space-y-1 text-xs text-amber-200">
                            <p className="font-bold text-amber-300 m-0">
                                Rebuild replica tables from primary snapshot?
                            </p>
                            <p className="m-0 text-[11px] text-nature-300">
                                This will clear local replica tables and reconstruct the full state from the primary node&apos;s signed snapshot. Any unmerged local divergence will be discarded.
                            </p>
                        </div>

                        <div className="flex items-center justify-end gap-3 pt-2">
                            <button
                                type="button"
                                onClick={() => setShowResyncConfirm(false)}
                                disabled={resyncing}
                                className="min-h-[44px] px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white transition-all disabled:opacity-50"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                id="confirm-resync-btn"
                                onClick={handleConfirmResync}
                                disabled={resyncing}
                                className="min-h-[44px] px-5 py-2 rounded-xl bg-amber-700 hover:bg-amber-600 text-xs font-bold text-white border border-amber-500 shadow-md transition-all disabled:opacity-50 flex items-center gap-2"
                            >
                                {resyncing ? (
                                    <>
                                        <span className="animate-spin text-sm">🔄</span>
                                        <span>Resyncing...</span>
                                    </>
                                ) : (
                                    <span>🔄 Force Resync</span>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
