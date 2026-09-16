import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { resolveNodeApiUrl, buildAdminHeaders, getTfaSessionToken } from '../../lib/node-client';

export interface ProbeLogEntry {
    timestamp: string;
    step: string;
    message: string;
    type: 'info' | 'success' | 'warning' | 'error';
}

export interface PublicAddressStatus {
    success?: boolean;
    status: 'live' | 'pending' | 'none' | 'error' | string;
    name?: string;
    hostname?: string;
    mode?: 'tunnel' | 'direct' | string;
    tunnelToken?: string;
    pubkey?: string;
    cached?: boolean;
    error?: string;
    communityName?: string;
    contact?: string;
    warning?: string;
}

export interface PublicAddressPanelProps {
    activeNode: NodeProfile;
    onRefreshDiag?: () => void;
}

export function PublicAddressPanel({ activeNode, onRefreshDiag }: PublicAddressPanelProps) {
    const [statusData, setStatusData] = useState<PublicAddressStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [logs, setLogs] = useState<ProbeLogEntry[]>([]);
    const [isPollingLogs, setIsPollingLogs] = useState(false);

    // Form inputs for claim
    const [claimName, setClaimName] = useState('');
    const [claimMode, setClaimMode] = useState<'tunnel' | 'direct'>('tunnel');
    const [communityName, setCommunityName] = useState('');
    const [contact, setContact] = useState('');
    const [formError, setFormError] = useState<string | null>(null);

    // Action status & states
    const [submittingClaim, setSubmittingClaim] = useState(false);
    const [restarting, setRestarting] = useState(false);
    const [takingOffline, setTakingOffline] = useState(false);
    const [actionMessage, setActionMessage] = useState<{ text: string; type: 'info' | 'success' | 'warning' | 'error' } | null>(null);

    // Confirmation dialog state for destructive actions
    const [confirmModal, setConfirmModal] = useState<{
        isOpen: boolean;
        title: string;
        message: string;
        actionType: 'restart' | 'offline';
        confirmButtonText: string;
    }>({
        isOpen: false,
        title: '',
        message: '',
        actionType: 'restart',
        confirmButtonText: '',
    });

    // Tunnel token display
    const [revealToken, setRevealToken] = useState(false);
    const [copySuccess, setCopySuccess] = useState(false);

    const logTerminalRef = useRef<HTMLDivElement>(null);
    const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Poll logs
    const fetchLogs = useCallback(async () => {
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/public-address/logs');
            const res = await fetch(url, {
                headers: buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
            });
            if (res.ok) {
                const data = await res.json().catch(() => ({}));
                if (Array.isArray(data?.logs)) {
                    setLogs(data.logs);
                } else if (Array.isArray(data)) {
                    setLogs(data);
                }
            }
        } catch {
            // Ignore fetch errors during log polling
        }
    }, [activeNode.url, activeNode.adminPassword, activeNode.id]);

    // Start background log monitor
    const startLogMonitor = useCallback(() => {
        setIsPollingLogs(true);
        fetchLogs();
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        pollTimerRef.current = setInterval(fetchLogs, 800);
    }, [fetchLogs]);

    // Stop background log monitor
    const stopLogMonitor = useCallback(() => {
        setTimeout(() => {
            fetchLogs();
            if (pollTimerRef.current) {
                clearInterval(pollTimerRef.current);
                pollTimerRef.current = null;
            }
            setIsPollingLogs(false);
        }, 3000);
    }, [fetchLogs]);

    // Fetch public address status
    const loadStatus = useCallback(async () => {
        setLoading(true);
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/public-address/status');
            const res = await fetch(url, {
                headers: buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
            });
            const data: PublicAddressStatus = await res.json().catch(() => ({ status: 'error', error: 'Invalid JSON response' }));
            if (res.ok) {
                setStatusData(data);
                if (data.communityName && !communityName) setCommunityName(String(data.communityName));
                if (data.contact && !contact) setContact(String(data.contact));
                if (data.name && !claimName) setClaimName(String(data.name));
            } else {
                setStatusData({
                    status: 'error',
                    error: typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`,
                });
            }
        } catch (e: unknown) {
            setStatusData({
                status: 'error',
                error: e instanceof Error ? e.message : 'Failed to reach node public address API',
            });
        } finally {
            setLoading(false);
            fetchLogs();
        }
    }, [activeNode.url, activeNode.adminPassword, activeNode.id, communityName, contact, claimName, fetchLogs]);

    useEffect(() => {
        loadStatus();
        return () => {
            if (pollTimerRef.current) {
                clearInterval(pollTimerRef.current);
                pollTimerRef.current = null;
            }
        };
    }, [loadStatus]);

    // Auto scroll log terminal to bottom on new logs
    useEffect(() => {
        if (logTerminalRef.current) {
            logTerminalRef.current.scrollTop = logTerminalRef.current.scrollHeight;
        }
    }, [logs]);

    // Subdomain sanitization and preview
    const cleanSubdomain = (val: string) => {
        return val.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '');
    };

    const handleSubdomainChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const cleaned = cleanSubdomain(e.target.value);
        setClaimName(cleaned);
        if (formError) setFormError(null);
    };

    const previewUrl = `https://${cleanSubdomain(claimName) || 'cairns'}.beanpool.org`;

    // Handle Claim Web Address
    const handleClaim = async (e: React.FormEvent) => {
        e.preventDefault();
        const trimmedName = cleanSubdomain(claimName);
        if (!trimmedName) {
            setFormError('Subdomain name is required');
            return;
        }
        if (!/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/.test(trimmedName)) {
            setFormError('Invalid name (3–32 chars: a–z, 0–9, hyphen, no leading/trailing hyphen)');
            return;
        }

        setFormError(null);
        setSubmittingClaim(true);
        setActionMessage({ text: '⏳ Claiming domain & registering with beanpool.org...', type: 'info' });
        startLogMonitor();

        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/public-address/claim');
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    ...buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    password: activeNode.adminPassword,
                    name: trimmedName,
                    mode: claimMode,
                    communityName: communityName.trim() || undefined,
                    contact: contact.trim() || undefined,
                }),
            });

            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                if (data.status === 'live') {
                    setActionMessage({
                        text: data.warning
                            ? '⏳ Address claimed! It can take a few minutes for the Cloudflare Tunnel to connect globally.'
                            : '🟢 Address Live & Verified!',
                        type: data.warning ? 'warning' : 'success',
                    });
                } else {
                    setActionMessage({
                        text: '⏳ Claimed — awaiting registrar approval',
                        type: 'success',
                    });
                }
                await loadStatus();
                onRefreshDiag?.();
            } else {
                setActionMessage({
                    text: typeof data.error === 'string' ? data.error : 'Claim failed',
                    type: 'error',
                });
            }
        } catch (e: unknown) {
            setActionMessage({
                text: e instanceof Error ? e.message : 'Claim request failed',
                type: 'error',
            });
        } finally {
            setSubmittingClaim(false);
            stopLogMonitor();
        }
    };

    // Trigger confirmation modal
    const requestRestartConfirmation = () => {
        setConfirmModal({
            isOpen: true,
            title: 'Restart Tunnel Sidecar',
            message: 'Are you sure you want to force-restart the Cloudflare tunnel sidecar process? Existing web connections may temporarily drop during container restart.',
            actionType: 'restart',
            confirmButtonText: 'Restart Sidecar',
        });
    };

    const requestOfflineConfirmation = () => {
        setConfirmModal({
            isOpen: true,
            title: 'Take Node Offline',
            message: `Release public address "${statusData?.hostname || statusData?.name || 'node'}" and take the node offline from the public internet? The Cloudflare tunnel and DNS record will be torn down.`,
            actionType: 'offline',
            confirmButtonText: 'Take Offline',
        });
    };

    // Execute confirmed destructive action
    const handleConfirmAction = async () => {
        const action = confirmModal.actionType;
        setConfirmModal((prev) => ({ ...prev, isOpen: false }));

        if (action === 'restart') {
            setRestarting(true);
            setActionMessage({ text: '⚡ Force-restarting tunnel sidecar container...', type: 'info' });
            startLogMonitor();
            try {
                const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/public-address/restart-sidecar');
                const res = await fetch(url, {
                    method: 'POST',
                    headers: {
                        ...buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ password: activeNode.adminPassword }),
                });
                const data = await res.json().catch(() => ({}));
                if (res.ok) {
                    setActionMessage({ text: '⚡ Tunnel sidecar restarted cleanly!', type: 'success' });
                    await loadStatus();
                } else {
                    setActionMessage({ text: typeof data.error === 'string' ? data.error : 'Restart failed', type: 'error' });
                }
            } catch (e: unknown) {
                setActionMessage({ text: e instanceof Error ? e.message : 'Restart failed', type: 'error' });
            } finally {
                setRestarting(false);
                stopLogMonitor();
            }
        } else if (action === 'offline') {
            setTakingOffline(true);
            setActionMessage({ text: '⏳ Releasing domain & tearing down tunnel...', type: 'info' });
            startLogMonitor();
            try {
                const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/public-address/offline');
                const res = await fetch(url, {
                    method: 'POST',
                    headers: {
                        ...buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ password: activeNode.adminPassword }),
                });
                const data = await res.json().catch(() => ({}));
                if (res.ok) {
                    setActionMessage({ text: '✓ Public address released. Node is offline.', type: 'success' });
                    setStatusData({ status: 'none' });
                    await loadStatus();
                    onRefreshDiag?.();
                } else {
                    setActionMessage({ text: typeof data.error === 'string' ? data.error : 'Failed to take offline', type: 'error' });
                }
            } catch (e: unknown) {
                setActionMessage({ text: e instanceof Error ? e.message : 'Failed to take offline', type: 'error' });
            } finally {
                setTakingOffline(false);
                stopLogMonitor();
            }
        }
    };

    // Copy tunnel token to clipboard
    const handleCopyToken = async () => {
        const token = statusData?.tunnelToken;
        if (!token) return;
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(String(token));
            } else {
                const textarea = document.createElement('textarea');
                textarea.value = String(token);
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);
            }
            setCopySuccess(true);
            setTimeout(() => setCopySuccess(false), 2000);
        } catch {
            setActionMessage({ text: 'Failed to copy token to clipboard', type: 'error' });
        }
    };

    // Safe getters for status data
    const rawStatus = typeof statusData?.status === 'string' ? statusData.status : '';
    const isLive = rawStatus === 'live';
    const isPending = rawStatus === 'pending';
    const isNone = rawStatus === 'none' || !statusData;
    const isError = rawStatus === 'error';
    const hostname = typeof statusData?.hostname === 'string' ? statusData.hostname : '';
    const mode = typeof statusData?.mode === 'string' ? statusData.mode : 'tunnel';
    const tunnelToken = typeof statusData?.tunnelToken === 'string' ? statusData.tunnelToken : '';
    const lastLog = logs.length > 0 ? logs[logs.length - 1] : null;
    const currentStep = typeof lastLog?.step === 'string' ? lastLog.step : 'Ready';

    return (
        <div className="space-y-6 max-w-4xl font-sans" data-testid="public-address-panel">
            {/* Header / Intro Card */}
            <div className="p-5 sm:p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-nature-800 pb-3">
                    <div>
                        <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                            <span>🌐</span>
                            <span>Public Address &amp; DNS Tunnel</span>
                        </h3>
                        <p className="text-xs text-nature-400 m-0 mt-0.5">
                            Connect your node to a memorable <code className="text-terra-400 font-mono">&lt;name&gt;.beanpool.org</code> address for browser access and mobile invite deep-links without SSH.
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => loadStatus()}
                        disabled={loading}
                        aria-label="Refresh public address status"
                        className="self-start sm:self-auto px-3 py-1.5 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-semibold text-nature-300 hover:text-white transition-all border border-nature-700 disabled:opacity-50"
                    >
                        {loading ? 'Refreshing…' : '🔄 Refresh'}
                    </button>
                </div>

                {/* Status Message Banner */}
                {actionMessage && (
                    <div
                        role="status"
                        aria-live="polite"
                        className={`p-3 rounded-xl border text-xs font-semibold flex items-center justify-between gap-2 ${
                            actionMessage.type === 'error'
                                ? 'bg-red-950/70 border-red-800 text-red-200'
                                : actionMessage.type === 'warning'
                                ? 'bg-amber-950/70 border-amber-800 text-amber-200'
                                : actionMessage.type === 'info'
                                ? 'bg-blue-950/70 border-blue-800 text-blue-200'
                                : 'bg-emerald-950/70 border-emerald-800 text-emerald-300'
                        }`}
                    >
                        <span>{actionMessage.text}</span>
                        <button
                            type="button"
                            onClick={() => setActionMessage(null)}
                            aria-label="Dismiss message"
                            className="text-nature-400 hover:text-white font-bold px-1"
                        >
                            ✕
                        </button>
                    </div>
                )}

                {/* Current Status Display Card */}
                <div className="p-4 rounded-xl bg-nature-950 border border-nature-800/80 space-y-3">
                    <div className="text-xs font-semibold text-nature-400 uppercase tracking-wider">
                        Current Registrar Status
                    </div>

                    {loading && !statusData ? (
                        <div className="text-xs text-nature-400 flex items-center gap-2">
                            <span className="animate-spin text-terra-400">⏳</span>
                            <span>Checking registrar status…</span>
                        </div>
                    ) : isLive ? (
                        <div className="space-y-3">
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 font-bold">
                                    <span>🟢</span>
                                    <span>Live</span>
                                </span>
                                {statusData?.cached && (
                                    <span className="text-[11px] text-amber-400 font-medium">
                                        (cached status)
                                    </span>
                                )}
                                <span className="text-nature-400">at</span>
                                <a
                                    href={hostname ? `https://${hostname}` : '#'}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-terra-400 hover:text-terra-300 font-bold font-mono underline break-all"
                                >
                                    {hostname || 'your-node.beanpool.org'}
                                </a>
                                <span className="text-nature-400 font-mono text-[11px]">
                                    ({mode === 'tunnel' ? '🛡️ tunnel' : '🌐 direct'})
                                </span>
                            </div>

                            {statusData?.error && (
                                <div className="text-xs text-red-400">
                                    Couldn&apos;t refresh registrar status — {String(statusData.error)}
                                </div>
                            )}

                            {/* Tunnel Token display (when live via tunnel) */}
                            {tunnelToken && (
                                <div className="p-3 rounded-xl bg-nature-900 border border-nature-800 space-y-1.5">
                                    <div className="flex flex-wrap items-center justify-between gap-1">
                                        <label htmlFor="tunnel-token-input" className="text-xs font-bold text-nature-300">
                                            Tunnel Token
                                        </label>
                                        <span className="text-[10px] text-nature-400">
                                            Keep secret; used by the Cloudflare sidecar connector
                                        </span>
                                    </div>
                                    <div className="flex flex-col sm:flex-row gap-2">
                                        <input
                                            id="tunnel-token-input"
                                            type={revealToken ? 'text' : 'password'}
                                            readOnly
                                            value={tunnelToken}
                                            className="flex-1 bg-nature-950 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white font-mono focus:outline-none select-all"
                                        />
                                        <div className="flex gap-2">
                                            <button
                                                type="button"
                                                onClick={() => setRevealToken(!revealToken)}
                                                className="px-3 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-semibold text-nature-200 border border-nature-700 shrink-0 min-h-[44px]"
                                            >
                                                {revealToken ? '🙈 Hide' : '👁️ Reveal'}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={handleCopyToken}
                                                className="px-3 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-semibold text-terra-400 hover:text-terra-300 border border-nature-700 shrink-0 min-h-[44px]"
                                            >
                                                {copySuccess ? '✓ Copied' : '📋 Copy'}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    ) : isPending ? (
                        <div className="space-y-2">
                            <div className="flex items-center gap-2 text-xs text-amber-400 font-bold">
                                <span>⏳</span>
                                <span>Awaiting registrar approval for</span>
                                <span className="font-mono underline text-white">
                                    {statusData?.name || 'subdomain'}.beanpool.org
                                </span>
                            </div>
                            <p className="text-xs text-nature-400 m-0">
                                Your registration request was signed and submitted. Once reviewed, Cloudflare DNS and edge tunnels will provision automatically.
                            </p>
                        </div>
                    ) : isNone ? (
                        <div className="text-xs text-nature-400">
                            No public address currently assigned. Set <code className="text-terra-400 font-mono">PUBLIC_ADDRESS_NAME</code> on your container or claim a domain below.
                        </div>
                    ) : (
                        <div className="text-xs text-red-400">
                            Couldn&apos;t reach the registrar{statusData?.error ? ` — ${String(statusData.error)}` : ''}.
                        </div>
                    )}

                    {/* Operational Action Buttons */}
                    <div className="flex flex-wrap items-center gap-2.5 pt-2 border-t border-nature-850">
                        <button
                            type="button"
                            onClick={requestRestartConfirmation}
                            disabled={restarting}
                            className="px-3.5 py-2 rounded-xl bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 hover:text-blue-300 text-xs font-bold border border-blue-500/30 transition-all disabled:opacity-50 min-h-[44px] flex items-center gap-1.5"
                        >
                            <span>⚡</span>
                            <span>{restarting ? 'Restarting…' : 'Reset Tunnel'}</span>
                        </button>

                        {(isLive || isPending) && (
                            <button
                                type="button"
                                onClick={requestOfflineConfirmation}
                                disabled={takingOffline}
                                className="px-3.5 py-2 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-400 hover:text-red-300 text-xs font-bold border border-red-500/30 transition-all disabled:opacity-50 min-h-[44px] flex items-center gap-1.5"
                            >
                                <span>🛑</span>
                                <span>{takingOffline ? 'Taking offline…' : 'Take offline'}</span>
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* Real-time Propagation Monitor Terminal */}
            <div className="p-5 sm:p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-3">
                <div className="flex items-center justify-between gap-2 border-b border-nature-800 pb-2.5">
                    <div className="flex items-center gap-2">
                        <span className="text-sm">📡</span>
                        <h4 className="text-xs font-bold text-white uppercase tracking-wider m-0">
                            Real-time DNS &amp; Edge Propagation Monitor
                        </h4>
                    </div>
                    <div className="flex items-center gap-2">
                        {isPollingLogs && (
                            <span className="w-2 h-2 rounded-full bg-terra-400 animate-ping" />
                        )}
                        <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-blue-500/20 text-blue-400 font-bold">
                            Step {currentStep}
                        </span>
                    </div>
                </div>

                <div
                    ref={logTerminalRef}
                    data-testid="propagation-monitor-terminal"
                    className="p-3.5 rounded-xl bg-[#090d16] border border-nature-800 font-mono text-xs max-h-52 overflow-y-auto space-y-1 text-nature-300"
                >
                    {logs.length === 0 ? (
                        <div className="text-nature-400 italic text-[11px]">
                            No propagation logs recorded yet. Initiating an address claim or tunnel reset will stream live steps here.
                        </div>
                    ) : (
                        logs.map((entry, idx) => {
                            const entryType = typeof entry?.type === 'string' ? entry.type : 'info';
                            const colorClass =
                                entryType === 'success'
                                    ? 'text-emerald-400'
                                    : entryType === 'warning'
                                    ? 'text-amber-400'
                                    : entryType === 'error'
                                    ? 'text-red-400'
                                    : 'text-nature-300';
                            return (
                                <div key={idx} className="flex items-start gap-2 leading-relaxed break-all">
                                    <span className="text-nature-400 text-[10px] shrink-0">
                                        [{entry?.timestamp || '--:--:--'}]
                                    </span>
                                    <span className="text-blue-400 font-semibold text-[10px] shrink-0">
                                        [{entry?.step || 'info'}]
                                    </span>
                                    <span className={colorClass}>
                                        {entry?.message || ''}
                                    </span>
                                </div>
                            );
                        })
                    )}
                </div>
            </div>

            {/* Claim Public Web Address Form (Available when status is 'none' or 'error' or operator wants to claim) */}
            <div className="p-5 sm:p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4">
                <div className="border-b border-nature-800 pb-3">
                    <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                        <span>🌐</span>
                        <span>Claim a Public Web Address (.beanpool.org)</span>
                    </h3>
                    <p className="text-xs text-nature-400 m-0 mt-0.5">
                        Register a custom <strong className="text-terra-400 font-bold">.beanpool.org</strong> subdomain for your node so members can discover and access your community securely from any browser.
                    </p>
                </div>

                {formError && (
                    <div role="alert" className="p-3 rounded-xl bg-red-950/70 border border-red-800 text-xs font-semibold text-red-200">
                        {formError}
                    </div>
                )}

                <form onSubmit={handleClaim} className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {/* Subdomain Input */}
                        <div>
                            <label htmlFor="pubaddr-subdomain-input" className="block text-xs font-bold text-nature-300 uppercase tracking-wider mb-1">
                                Subdomain Prefix
                            </label>
                            <input
                                id="pubaddr-subdomain-input"
                                type="text"
                                value={claimName}
                                onChange={handleSubdomainChange}
                                placeholder="e.g. cairns"
                                maxLength={32}
                                className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2.5 text-xs text-white font-mono focus:outline-none focus:border-terra-500 min-h-[44px]"
                            />
                            {/* Live Preview Bar */}
                            <div className="mt-1.5 p-2 rounded-lg bg-emerald-950/40 border border-emerald-800/40 text-[11px] font-mono text-emerald-300 flex items-center gap-1 break-all">
                                <span>🌐 URL:</span>
                                <strong className="text-emerald-200 font-bold">{previewUrl}</strong>
                            </div>
                        </div>

                        {/* Community Name */}
                        <div>
                            <label htmlFor="pubaddr-community-name-input" className="block text-xs font-bold text-nature-300 uppercase tracking-wider mb-1">
                                Community / Pool Name
                            </label>
                            <input
                                id="pubaddr-community-name-input"
                                type="text"
                                value={communityName}
                                onChange={(e) => setCommunityName(e.target.value)}
                                placeholder="e.g. Cairns Community"
                                className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none focus:border-terra-500 min-h-[44px]"
                            />
                            <span className="text-[10px] text-nature-400 block mt-1">
                                Displayed in public directory and browser title
                            </span>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {/* Operator Contact */}
                        <div>
                            <label htmlFor="pubaddr-contact-input" className="block text-xs font-bold text-nature-300 uppercase tracking-wider mb-1">
                                Operator Contact (Email or Handle)
                            </label>
                            <input
                                id="pubaddr-contact-input"
                                type="text"
                                value={contact}
                                onChange={(e) => setContact(e.target.value)}
                                placeholder="e.g. name@yourdomain.org"
                                className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none focus:border-terra-500 min-h-[44px]"
                            />
                            <span className="text-[10px] text-nature-400 block mt-1">
                                Used by registrar administrators for critical node operational notices
                            </span>
                        </div>

                        {/* Reachability Mode (per docs/node-dns-registrar.md) */}
                        <div>
                            <label htmlFor="pubaddr-mode-select" className="block text-xs font-bold text-nature-300 uppercase tracking-wider mb-1">
                                Reachability Mode
                            </label>
                            <select
                                id="pubaddr-mode-select"
                                value={claimMode}
                                onChange={(e) => setClaimMode(e.target.value as 'tunnel' | 'direct')}
                                className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none focus:border-terra-500 min-h-[44px]"
                            >
                                <option value="tunnel">🛡️ Tunnel (recommended default)</option>
                                <option value="direct">🌐 Direct (public IP / own cert)</option>
                            </select>
                            <div className="text-[10px] text-nature-400 mt-1 leading-normal">
                                {claimMode === 'tunnel' ? (
                                    <span>
                                        Outbound Cloudflare sidecar. Works behind NAT/firewalls, dynamic IP friendly, DDoS shielded, no exposed origin IP.
                                    </span>
                                ) : (
                                    <span>
                                        Direct DNS A-record to your server IP. Requires static public IP, open :443/:80, and self-managed TLS certificates.
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="pt-2">
                        <button
                            type="submit"
                            disabled={submittingClaim}
                            className="w-full sm:w-auto px-6 py-2.5 rounded-xl bg-terra-600 hover:bg-terra-500 active:scale-95 text-xs font-bold text-white transition-all shadow-lg disabled:opacity-50 min-h-[44px]"
                        >
                            {submittingClaim ? 'Registering with Registrar…' : 'Go public · Claim Web Address'}
                        </button>
                    </div>
                </form>
            </div>

            {/* Confirmation Modal for Destructive Actions */}
            {confirmModal.isOpen && (
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="confirm-modal-title"
                    className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in"
                >
                    <div className="w-full max-w-md bg-nature-900 border border-nature-700 rounded-2xl p-6 shadow-2xl space-y-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-amber-500/20 text-amber-400 border border-amber-500/30 flex items-center justify-center text-lg shrink-0">
                                ⚠️
                            </div>
                            <h3 id="confirm-modal-title" className="text-base font-bold text-white m-0">
                                {confirmModal.title}
                            </h3>
                        </div>

                        <p className="text-xs text-nature-300 leading-relaxed m-0">
                            {confirmModal.message}
                        </p>

                        <div className="flex items-center justify-end gap-3 pt-3 border-t border-nature-800">
                            <button
                                type="button"
                                onClick={() => setConfirmModal((prev) => ({ ...prev, isOpen: false }))}
                                className="px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-semibold text-nature-300 hover:text-white transition-all min-h-[40px]"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={handleConfirmAction}
                                className={`px-4 py-2 rounded-xl text-xs font-bold text-white transition-all min-h-[40px] ${
                                    confirmModal.actionType === 'offline'
                                        ? 'bg-red-600 hover:bg-red-500'
                                        : 'bg-blue-600 hover:bg-blue-500'
                                }`}
                            >
                                {confirmModal.confirmButtonText}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
