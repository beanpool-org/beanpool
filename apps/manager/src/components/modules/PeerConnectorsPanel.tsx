import React, { useState, useEffect, useCallback } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { resolveNodeApiUrl, buildAdminHeaders, getTfaSessionToken } from '../../lib/node-client';

export interface PeerConnector {
    address: string;
    trustLevel?: 'mirror' | 'peer' | 'blocked' | string;
    callsign?: string;
    enabled?: boolean; // false = passive, true/undefined = active
    remoteActive?: boolean;
    connected?: boolean;
    mutualTrust?: boolean;
    latencyMs?: number | null;
    lastVerified?: number | null;
    remoteTrustLevel?: string;
    publicUrl?: string;
    name?: string;
    peerId?: string;
    url?: string;
    id?: string;
    [key: string]: unknown;
}

export interface PeerConnectorsPanelProps {
    activeNode: NodeProfile;
    activeWsConnections?: number;
    p2pActivePeers?: number;
}

export function PeerConnectorsPanel({
    activeNode,
    activeWsConnections = 0,
    p2pActivePeers = 0,
}: PeerConnectorsPanelProps) {
    const [connectors, setConnectors] = useState<PeerConnector[]>([]);
    const [loading, setLoading] = useState(true);
    const [statusMsg, setStatusMsg] = useState<{ text: string; isError: boolean } | null>(null);

    // Add connector form state
    const [newAddress, setNewAddress] = useState('');
    const [newTrustLevel, setNewTrustLevel] = useState<'peer' | 'blocked' | 'mirror'>('peer');
    const [newMode, setNewMode] = useState<'active' | 'passive'>('active');
    const [newCallsign, setNewCallsign] = useState('');
    const [newPublicUrl, setNewPublicUrl] = useState('');
    const [adding, setAdding] = useState(false);

    // In-flight action addresses
    const [actionInProgress, setActionInProgress] = useState<Record<string, string>>({});

    // Confirmation dialog for destructive actions (e.g. remove peer)
    const [confirmModal, setConfirmModal] = useState<{
        isOpen: boolean;
        address: string;
        callsign?: string;
    }>({
        isOpen: false,
        address: '',
        callsign: '',
    });

    const loadConnectors = useCallback(async () => {
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/connectors');
            const res = await fetch(url, {
                headers: buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
            });
            if (res.ok) {
                const data = await res.json().catch(() => []);
                if (Array.isArray(data)) {
                    setConnectors(data);
                } else if (Array.isArray(data?.connectors)) {
                    setConnectors(data.connectors);
                } else {
                    setConnectors([]);
                }
            } else {
                setConnectors([]);
            }
        } catch {
            setConnectors([]);
        } finally {
            setLoading(false);
        }
    }, [activeNode.url, activeNode.adminPassword, activeNode.id]);

    useEffect(() => {
        loadConnectors();
    }, [loadConnectors]);

    // Close confirmation modal on Escape key
    useEffect(() => {
        if (!confirmModal.isOpen) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setConfirmModal({ isOpen: false, address: '', callsign: '' });
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [confirmModal.isOpen]);

    // Handle Add Connector / Peer
    const handleAddConnector = async (e: React.FormEvent) => {
        e.preventDefault();
        const address = newAddress.trim();
        if (!address) {
            setStatusMsg({ text: 'Address is required', isError: true });
            return;
        }

        setAdding(true);
        setStatusMsg(null);

        try {
            // 1. Add/configure connector in connectors list
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/connectors');
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    ...buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    password: activeNode.adminPassword,
                    address,
                    trustLevel: newTrustLevel,
                    callsign: newCallsign.trim() || undefined,
                    enabled: newMode === 'active',
                    publicUrl: newPublicUrl.trim() || undefined,
                }),
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${res.status}`);
            }

            // 2. If active mode, dial connection immediately
            if (newMode === 'active') {
                const connUrl = resolveNodeApiUrl(activeNode.url, '/api/local/connectors/connect');
                await fetch(connUrl, {
                    method: 'POST',
                    headers: {
                        ...buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        password: activeNode.adminPassword,
                        address,
                    }),
                }).catch(() => null);
            }

            setStatusMsg({ text: `Connector ${address} added successfully!`, isError: false });
            setNewAddress('');
            setNewCallsign('');
            setNewPublicUrl('');
            await loadConnectors();
        } catch (e: unknown) {
            setStatusMsg({
                text: e instanceof Error ? e.message : 'Failed to add connector',
                isError: true,
            });
        } finally {
            setAdding(false);
        }
    };

    // Connect to peer
    const handleConnect = async (address: string) => {
        setActionInProgress((prev) => ({ ...prev, [address]: 'connecting' }));
        setStatusMsg(null);
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/connectors/connect');
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    ...buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    password: activeNode.adminPassword,
                    address,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.success === false) {
                throw new Error(data.error || 'Connection failed — peer unreachable');
            }
            setStatusMsg({ text: `Connected to ${address}`, isError: false });
            await loadConnectors();
        } catch (e: unknown) {
            setStatusMsg({
                text: e instanceof Error ? e.message : 'Connection failed',
                isError: true,
            });
        } finally {
            setActionInProgress((prev) => {
                const next = { ...prev };
                delete next[address];
                return next;
            });
        }
    };

    // Disconnect from peer
    const handleDisconnect = async (address: string) => {
        setActionInProgress((prev) => ({ ...prev, [address]: 'disconnecting' }));
        setStatusMsg(null);
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/connectors/disconnect');
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    ...buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    password: activeNode.adminPassword,
                    address,
                }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || 'Disconnect failed');
            }
            setStatusMsg({ text: `Disconnected from ${address}`, isError: false });
            await loadConnectors();
        } catch (e: unknown) {
            setStatusMsg({
                text: e instanceof Error ? e.message : 'Disconnect failed',
                isError: true,
            });
        } finally {
            setActionInProgress((prev) => {
                const next = { ...prev };
                delete next[address];
                return next;
            });
        }
    };

    // Toggle active / passive mode
    const handleToggleMode = async (connector: PeerConnector) => {
        const address = connector.address || connector.url || '';
        if (!address) {
            setStatusMsg({ text: 'Unable to toggle mode: connector address is missing', isError: true });
            return;
        }
        const makeActive = connector.enabled === false; // Currently passive -> make active
        setActionInProgress((prev) => ({ ...prev, [address]: 'toggling-mode' }));
        setStatusMsg(null);
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/connectors');
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    ...buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    password: activeNode.adminPassword,
                    address,
                    trustLevel: connector.trustLevel || 'peer',
                    callsign: connector.callsign || undefined,
                    enabled: makeActive,
                    publicUrl: connector.publicUrl || undefined,
                }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || 'Failed to update connector mode');
            }
            setStatusMsg({
                text: `Switched ${address} to ${makeActive ? 'Active' : 'Passive'} mode`,
                isError: false,
            });
            await loadConnectors();
        } catch (e: unknown) {
            setStatusMsg({
                text: e instanceof Error ? e.message : 'Failed to toggle mode',
                isError: true,
            });
        } finally {
            setActionInProgress((prev) => {
                const next = { ...prev };
                delete next[address];
                return next;
            });
        }
    };

    // Prompt remove confirmation
    const requestRemoveConfirmation = (connector: PeerConnector) => {
        const address = connector.address || connector.url || '';
        setConfirmModal({
            isOpen: true,
            address,
            callsign: connector.callsign || '',
        });
    };

    // Execute confirmed remove
    const handleConfirmRemove = async () => {
        const address = confirmModal.address;
        setConfirmModal({ isOpen: false, address: '', callsign: '' });
        if (!address) return;

        setActionInProgress((prev) => ({ ...prev, [address]: 'removing' }));
        setStatusMsg(null);
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/connectors/remove');
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    ...buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    password: activeNode.adminPassword,
                    address,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.success === false) {
                throw new Error(data.error || 'Remove failed');
            }
            setStatusMsg({ text: `Removed connector ${address}`, isError: false });
            await loadConnectors();
        } catch (e: unknown) {
            setStatusMsg({
                text: e instanceof Error ? e.message : 'Remove failed',
                isError: true,
            });
        } finally {
            setActionInProgress((prev) => {
                const next = { ...prev };
                delete next[address];
                return next;
            });
        }
    };

    const trustLabels: Record<string, string> = {
        mirror: 'Mirror',
        peer: 'Peer',
        blocked: 'Blocked',
    };

    return (
        <div className="p-5 sm:p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-5 font-sans" data-testid="peer-connectors-panel">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-nature-800 pb-3">
                <div>
                    <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                        <span>🔗</span>
                        <span>Trusted Mesh Connectors</span>
                    </h3>
                    <p className="text-xs text-nature-400 m-0 mt-0.5">
                        Both nodes must add each other as connectors for mutual trust. Active streams: {activeWsConnections} ws · {p2pActivePeers} p2p peers
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => loadConnectors()}
                    disabled={loading}
                    aria-label="Refresh connectors"
                    className="self-start sm:self-auto px-3 py-1.5 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-semibold text-nature-300 hover:text-white transition-all border border-nature-700 disabled:opacity-50"
                >
                    {loading ? 'Refreshing…' : '🔄 Refresh'}
                </button>
            </div>

            {/* Status Message */}
            {statusMsg && (
                <div
                    role="status"
                    aria-live="polite"
                    className={`p-3 rounded-xl border text-xs font-semibold flex items-center justify-between gap-2 ${
                        statusMsg.isError
                            ? 'bg-red-950/70 border-red-800 text-red-200'
                            : 'bg-emerald-950/70 border-emerald-800 text-emerald-300'
                    }`}
                >
                    <span>{statusMsg.text}</span>
                    <button
                        type="button"
                        onClick={() => setStatusMsg(null)}
                        aria-label="Dismiss message"
                        className="text-nature-400 hover:text-white font-bold px-1"
                    >
                        ✕
                    </button>
                </div>
            )}

            {/* Connectors List */}
            <div className="space-y-3" data-testid="connectors-list">
                {loading && connectors.length === 0 ? (
                    <div className="p-4 rounded-xl bg-nature-950 border border-nature-800 text-xs text-nature-400 flex items-center gap-2">
                        <span className="animate-spin text-terra-400">⏳</span>
                        <span>Loading connectors…</span>
                    </div>
                ) : connectors.length === 0 ? (
                    <div className="p-6 rounded-xl bg-nature-950 border border-nature-800/80 text-center space-y-1">
                        <div className="text-xs font-semibold text-nature-300">No connectors configured</div>
                        <p className="text-[11px] text-nature-500 m-0">Add a peer below to initiate federation and sync.</p>
                    </div>
                ) : (
                    connectors.map((c, idx) => {
                        const safeAddress = typeof c?.address === 'string' ? c.address : (typeof c?.url === 'string' ? c.url : `peer-${idx}`);
                        const safeCallsign = typeof c?.callsign === 'string' ? c.callsign : (typeof c?.name === 'string' ? c.name : '');
                        const isPassive = c?.enabled === false;
                        const isConnected = Boolean(c?.connected);
                        const isMutual = Boolean(c?.mutualTrust);

                        // Collision & Deadlock detection (audit Bucket 1 #4)
                        const isCollision = c?.enabled !== false && c?.remoteActive === true;
                        const isDeadlock = c?.enabled === false && c?.remoteActive === false;

                        // Latency formatting
                        let latency = '—';
                        if (typeof c?.latencyMs === 'number' && c.latencyMs > 0) {
                            latency = `${c.latencyMs}ms`;
                        } else if (isConnected && isPassive) {
                            latency = '— (Inbound Verified)';
                        }

                        const currentAction = actionInProgress[safeAddress];

                        return (
                            <div
                                key={c?.id || safeAddress || idx}
                                data-testid={`connector-card-${safeAddress}`}
                                className="p-4 rounded-xl bg-nature-950 border border-nature-800 hover:border-nature-700/80 transition-all space-y-3"
                            >
                                {/* Card Header */}
                                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                                    <div className="min-w-0">
                                        <div className="text-xs font-bold text-white flex items-center gap-2 truncate">
                                            <span className="truncate">{safeCallsign || safeAddress}</span>
                                        </div>
                                        <div className="text-[11px] font-mono text-nature-400 truncate mt-0.5">
                                            {safeAddress}
                                        </div>
                                    </div>

                                    {/* Badges */}
                                    <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                                        {/* Active / Passive mode badge */}
                                        {isPassive ? (
                                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-slate-500/15 border border-slate-500/30 text-slate-300">
                                                <span aria-hidden="true">💤</span>
                                                <span>Passive</span>
                                            </span>
                                        ) : (
                                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/15 border border-amber-500/30 text-amber-300">
                                                <span aria-hidden="true">⚡</span>
                                                <span>Active</span>
                                            </span>
                                        )}

                                        {/* Collision badge */}
                                        {isCollision && (
                                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-red-500/20 border border-red-500/40 text-red-300 animate-pulse">
                                                <span aria-hidden="true">⚠️</span>
                                                <span>Collision</span>
                                            </span>
                                        )}

                                        {/* Deadlock badge */}
                                        {isDeadlock && (
                                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 border border-amber-500/40 text-amber-300">
                                                <span aria-hidden="true">⚠️</span>
                                                <span>Deadlock</span>
                                            </span>
                                        )}

                                        {/* Connection status badge */}
                                        {isConnected && isMutual ? (
                                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">
                                                <span>●</span>
                                                <span>Mutual Trust</span>
                                            </span>
                                        ) : isConnected ? (
                                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-blue-500/15 border border-blue-500/30 text-blue-300">
                                                <span>◐</span>
                                                <span>Outbound Only</span>
                                            </span>
                                        ) : (
                                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-nature-800 border border-nature-700 text-nature-400">
                                                <span>○</span>
                                                <span>Disconnected</span>
                                            </span>
                                        )}
                                    </div>
                                </div>

                                {/* Meta details */}
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px] text-nature-400 border-t border-nature-900 pt-2 font-mono">
                                    <div>
                                        You → <strong className="text-nature-200">{trustLabels[String(c?.trustLevel)] || String(c?.trustLevel || 'peer')}</strong>
                                    </div>
                                    <div>
                                        Them → <strong className="text-nature-200">{trustLabels[String(c?.remoteTrustLevel)] || String(c?.remoteTrustLevel || '—')}</strong>
                                    </div>
                                    <div>
                                        RTT: <strong className="text-nature-200">{latency}</strong>
                                    </div>
                                </div>

                                {/* Dual Active Collision Alert */}
                                {isCollision && (
                                    <div className="p-3 rounded-xl bg-red-950/40 border border-red-800/60 text-xs text-red-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                                        <div className="flex items-start gap-2">
                                            <span className="text-base" aria-hidden="true">⚠️</span>
                                            <div>
                                                <strong className="block text-red-300 font-bold">Dual Active Collision!</strong>
                                                <span>Both nodes are configured as Active dialers. Switch to Passive on one node to prevent connection collisions.</span>
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => handleToggleMode(c)}
                                            disabled={Boolean(currentAction)}
                                            className="px-3.5 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white font-bold text-xs shrink-0 self-start sm:self-auto transition-all min-h-[44px] flex items-center justify-center"
                                        >
                                            💤 Make Passive
                                        </button>
                                    </div>
                                )}

                                {/* Dual Passive Deadlock Alert */}
                                {isDeadlock && (
                                    <div className="p-3 rounded-xl bg-amber-950/40 border border-amber-800/60 text-xs text-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                                        <div className="flex items-start gap-2">
                                            <span className="text-base" aria-hidden="true">⚠️</span>
                                            <div>
                                                <strong className="block text-amber-300 font-bold">Dual Passive Deadlock!</strong>
                                                <span>Both nodes are configured as Passive listeners. Neither node initiates synchronization.</span>
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => handleToggleMode(c)}
                                            disabled={Boolean(currentAction)}
                                            className="px-3.5 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs shrink-0 self-start sm:self-auto transition-all min-h-[44px] flex items-center justify-center"
                                        >
                                            ⚡ Make Active
                                        </button>
                                    </div>
                                )}

                                {/* Action Buttons */}
                                <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-nature-900">
                                    {isConnected ? (
                                        <button
                                            type="button"
                                            onClick={() => handleDisconnect(safeAddress)}
                                            disabled={Boolean(currentAction)}
                                            className="px-3 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-semibold text-nature-200 border border-nature-700 transition-all disabled:opacity-50 min-h-[44px]"
                                        >
                                            {currentAction === 'disconnecting' ? 'Disconnecting…' : 'Disconnect'}
                                        </button>
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={() => handleConnect(safeAddress)}
                                            disabled={Boolean(currentAction)}
                                            className="px-3 py-2 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all disabled:opacity-50 min-h-[44px]"
                                        >
                                            {currentAction === 'connecting' ? 'Connecting…' : 'Connect'}
                                        </button>
                                    )}

                                    <button
                                        type="button"
                                        onClick={() => handleToggleMode(c)}
                                        disabled={Boolean(currentAction)}
                                        className="px-3 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-semibold text-nature-200 border border-nature-700 transition-all disabled:opacity-50 min-h-[44px]"
                                    >
                                        {currentAction === 'toggling-mode'
                                            ? 'Updating mode…'
                                            : isPassive
                                            ? '⚡ Make Active'
                                            : '💤 Make Passive'}
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() => requestRemoveConfirmation(c)}
                                        disabled={Boolean(currentAction)}
                                        className="px-3 py-2 rounded-xl bg-red-950/50 hover:bg-red-900/60 text-xs font-bold text-red-400 hover:text-red-300 border border-red-800/60 transition-all disabled:opacity-50 min-h-[44px]"
                                    >
                                        {currentAction === 'removing' ? 'Removing…' : 'Remove'}
                                    </button>
                                </div>
                            </div>
                        );
                    })
                )}
            </div>

            {/* Connection Mode Guide (audit Bucket 1 #4; legacy settings.html:1022-1036) */}
            <div className="p-4 rounded-xl bg-blue-950/20 border border-dashed border-blue-500/30 text-xs text-nature-300 space-y-2">
                <strong className="text-blue-400 font-bold block text-xs">
                    💡 Connection Mode Guide
                </strong>
                <p className="m-0 text-nature-400 text-[11px] leading-relaxed">
                    For optimal stability and resource usage across federated communities:
                </p>
                <ul className="m-0 pl-4 space-y-1 text-[11px] text-nature-300 list-disc">
                    <li>
                        Configure one node as <strong className="text-amber-400"><span aria-hidden="true">⚡</span> Active</strong> (e.g. your private home NAS or backup mirror).
                    </li>
                    <li>
                        Configure the other node as <strong className="text-slate-300"><span aria-hidden="true">💤</span> Passive</strong> (e.g. your public load-balanced server).
                    </li>
                    <li>
                        Avoid setting both nodes to Active, as simultaneous outbound dialing causes connection collisions.
                    </li>
                    <li>
                        Connection Mode only decides <em>who dials</em>. A Passive peer trades exactly like an Active one — to stop trading with a community, set its Trust Level to <strong className="text-slate-300">Blocked</strong>.
                    </li>
                </ul>
            </div>

            {/* Add New Connector Form (legacy settings.html:1040-1067) */}
            <div className="p-4 rounded-xl bg-nature-950 border border-nature-800/80 space-y-3">
                <h4 className="text-xs font-bold text-white uppercase tracking-wider m-0">
                    Add New Connector
                </h4>

                <form onSubmit={handleAddConnector} className="space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                            <label htmlFor="new-connector-addr" className="block text-xs font-bold text-nature-300 mb-1">
                                Peer Address <span className="text-terra-400">*</span>
                            </label>
                            <input
                                id="new-connector-addr"
                                type="text"
                                required
                                aria-required="true"
                                value={newAddress}
                                onChange={(e) => setNewAddress(e.target.value)}
                                placeholder="e.g. us.beanpool.org:4001 or wss://peer.beanpool.org"
                                className="w-full bg-nature-900 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-terra-500 min-h-[44px]"
                            />
                        </div>

                        <div>
                            <label htmlFor="new-connector-callsign" className="block text-xs font-bold text-nature-300 mb-1">
                                Callsign (Optional)
                            </label>
                            <input
                                id="new-connector-callsign"
                                type="text"
                                value={newCallsign}
                                onChange={(e) => setNewCallsign(e.target.value)}
                                placeholder="e.g. US Node"
                                maxLength={20}
                                className="w-full bg-nature-900 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-terra-500 min-h-[44px]"
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                            <label htmlFor="new-connector-trust" className="block text-xs font-bold text-nature-300 mb-1">
                                Trust Level
                            </label>
                            <select
                                id="new-connector-trust"
                                value={newTrustLevel}
                                onChange={(e) => setNewTrustLevel(e.target.value as any)}
                                className="w-full bg-nature-900 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-terra-500 min-h-[44px]"
                            >
                                <option value="peer">Peer (Federation)</option>
                                <option value="mirror">Mirror (Replication)</option>
                                <option value="blocked">Blocked</option>
                            </select>
                        </div>

                        <div>
                            <label htmlFor="new-connector-mode" className="block text-xs font-bold text-nature-300 mb-1">
                                Connection Mode
                            </label>
                            <select
                                id="new-connector-mode"
                                value={newMode}
                                onChange={(e) => setNewMode(e.target.value as any)}
                                className="w-full bg-nature-900 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-terra-500 min-h-[44px]"
                            >
                                <option value="active">⚡ Active (Outbound Dial)</option>
                                <option value="passive">💤 Passive (Inbound Listen)</option>
                            </select>
                        </div>
                    </div>

                    <div>
                        <label htmlFor="new-connector-public-url" className="block text-xs font-bold text-nature-300 mb-1">
                            Public URL (Optional)
                        </label>
                        <input
                            id="new-connector-public-url"
                            type="text"
                            value={newPublicUrl}
                            onChange={(e) => setNewPublicUrl(e.target.value)}
                            placeholder="e.g. https://eastgippy.beanpool.org:8450"
                            className="w-full bg-nature-900 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-terra-500 min-h-[44px]"
                        />
                        <span className="text-[10px] text-nature-500 block mt-1">
                            Used for cross-node purchase routing and peer catalog queries
                        </span>
                    </div>

                    <div className="pt-1">
                        <button
                            type="submit"
                            disabled={adding}
                            className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all disabled:opacity-50 min-h-[44px]"
                        >
                            {adding ? 'Adding Peer…' : 'Add Peer'}
                        </button>
                    </div>
                </form>
            </div>

            {/* Confirmation Modal for Removing Peer */}
            {confirmModal.isOpen && (
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="remove-peer-modal-title"
                    onClick={(e) => {
                        if (e.target === e.currentTarget) {
                            setConfirmModal({ isOpen: false, address: '', callsign: '' });
                        }
                    }}
                    className="fixed inset-0 overflow-y-auto z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in"
                >
                    <div className="m-auto w-full max-w-md bg-nature-900 border border-nature-700 rounded-2xl p-6 shadow-2xl space-y-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-red-500/20 text-red-400 border border-red-500/30 flex items-center justify-center text-lg shrink-0">
                                🛑
                            </div>
                            <h3 id="remove-peer-modal-title" className="text-base font-bold text-white m-0">
                                Remove Peer Connector
                            </h3>
                        </div>

                        <p className="text-xs text-nature-300 leading-relaxed m-0">
                            Are you sure you want to remove connector <strong className="text-white font-mono break-all">{confirmModal.address}</strong>
                            {confirmModal.callsign ? ` (${confirmModal.callsign})` : ''}? Active mesh federation and ledger synchronization with this peer will cease.
                        </p>

                        <div className="flex items-center justify-end gap-3 pt-3 border-t border-nature-800">
                            <button
                                type="button"
                                onClick={() => setConfirmModal({ isOpen: false, address: '', callsign: '' })}
                                className="px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-semibold text-nature-300 hover:text-white transition-all min-h-[44px]"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={handleConfirmRemove}
                                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-xs font-bold text-white transition-all min-h-[44px]"
                            >
                                Remove Connector
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
