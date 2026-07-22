import React from 'react';
import type { NodeProfile } from '../../lib/profiles';
import type { DiagnosticsResponse } from '../../lib/node-client';

export interface NodeDiagnosticState {
    diag: DiagnosticsResponse | null;
    loading: boolean;
    error: string | null;
}

interface TelemetryModuleProps {
    profiles: NodeProfile[];
    activeProfileId: string;
    fleetDiags: Record<string, NodeDiagnosticState>;
    fleetNodeData?: Record<string, any>;
    onSelectNode: (id: string) => void;
    onInspectNodeThreats?: (id: string) => void;
    onEditNode: (node: NodeProfile) => void;
    onRefreshFleet: () => void;
}

export function TelemetryModule({
    profiles,
    activeProfileId,
    fleetDiags,
    fleetNodeData,
    onSelectNode,
    onInspectNodeThreats,
    onEditNode,
    onRefreshFleet,
}: TelemetryModuleProps) {
    const isGlobalLoading = Object.values(fleetDiags).some((d) => d?.loading);

    // Calculate aggregated fleet metrics
    const onlineNodesCount = profiles.filter(
        (p) => fleetDiags[p.id]?.diag && !fleetDiags[p.id]?.error
    ).length;

    const totalDbBytes = profiles.reduce((acc, p) => {
        return acc + (fleetDiags[p.id]?.diag?.dbSizeBytes || 0);
    }, 0);

    const totalWsConnections = profiles.reduce((acc, p) => {
        return acc + (fleetDiags[p.id]?.diag?.activeWsConnections || 0);
    }, 0);

    const totalP2pPeers = profiles.reduce((acc, p) => {
        return acc + (fleetDiags[p.id]?.diag?.p2pActivePeers || 0);
    }, 0);

    const totalFleetUsers = profiles.reduce((acc, p) => {
        const diagCount = fleetDiags[p.id]?.diag?.userCount;
        if (typeof diagCount === 'number') {
            return acc + diagCount;
        }
        const nodeMembers = fleetNodeData?.[p.id]?.members;
        if (Array.isArray(nodeMembers)) {
            return acc + nodeMembers.length;
        }
        return acc;
    }, 0);

    return (
        <div className="space-y-6 animate-fade-in font-sans">
            {/* Header */}
            <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                    <h2 className="text-xl font-bold text-white tracking-tight m-0 flex items-center gap-2.5">
                        <span>📊 Multi-Node Fleet Telemetry & Health</span>
                        <span className="px-2.5 py-0.5 rounded-full bg-terra-500/20 text-terra-300 border border-terra-500/30 text-xs font-mono font-bold">
                            {profiles.length} Nodes Fleet
                        </span>
                    </h2>
                    <p className="text-xs text-nature-400 m-0 mt-1">
                        Real-time hardware diagnostics, SQLite storage, process uptime, registered users, and WebSocket mesh streams across all connected nodes.
                    </p>
                </div>
                <button
                    onClick={onRefreshFleet}
                    disabled={isGlobalLoading}
                    className="px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all flex items-center gap-2 active:scale-95 shadow-md"
                >
                    <span className={isGlobalLoading ? 'animate-spin' : ''}>🔄</span>
                    <span>{isGlobalLoading ? 'Refreshing Fleet...' : 'Refresh Fleet Telemetry'}</span>
                </button>
            </div>

            {/* Fleet At-a-Glance Summary Ribbon */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 text-xs font-sans">
                <div className="bg-nature-900/90 border border-nature-800 rounded-2xl p-4 space-y-1">
                    <span className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400 block">Fleet Standing</span>
                    <div className="text-xl font-black text-emerald-400 font-mono">
                        {onlineNodesCount} / {profiles.length} Online
                    </div>
                    <span className="text-[11px] text-nature-400 font-semibold">Active Sovereign Nodes</span>
                </div>
                <div className="bg-nature-900/90 border border-nature-800 rounded-2xl p-4 space-y-1">
                    <span className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400 block">Total Users</span>
                    <div className="text-xl font-black text-indigo-400 font-mono">
                        {totalFleetUsers} Users
                    </div>
                    <span className="text-[11px] text-nature-400 font-semibold">Registered across fleet</span>
                </div>
                <div className="bg-nature-900/90 border border-nature-800 rounded-2xl p-4 space-y-1">
                    <span className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400 block">Total Storage</span>
                    <div className="text-xl font-black text-amber-400 font-mono">
                        {(totalDbBytes / (1024 * 1024)).toFixed(2)} MB
                    </div>
                    <span className="text-[11px] text-nature-400 font-semibold">SQLite Storage across fleet</span>
                </div>
                <div className="bg-nature-900/90 border border-nature-800 rounded-2xl p-4 space-y-1">
                    <span className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400 block">Active WebSockets</span>
                    <div className="text-xl font-black text-sky-400 font-mono">
                        {totalWsConnections} Streams
                    </div>
                    <span className="text-[11px] text-nature-400 font-semibold">Live client connections</span>
                </div>
                <div className="bg-nature-900/90 border border-nature-800 rounded-2xl p-4 space-y-1">
                    <span className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400 block">P2P Mesh Peers</span>
                    <div className="text-xl font-black text-purple-400 font-mono">
                        {totalP2pPeers} Peers
                    </div>
                    <span className="text-[11px] text-nature-400 font-semibold">Inter-node P2P links</span>
                </div>
            </div>

            {/* List of All Nodes with Individual Telemetry Cards */}
            <div className="space-y-4">
                <h3 className="text-xs font-extrabold text-nature-300 uppercase tracking-wider">
                    Sovereign Node Diagnostics Cards ({profiles.length})
                </h3>

                <div className="space-y-4">
                    {profiles.map((profile) => {
                        const isSelected = profile.id === activeProfileId;
                        const state = fleetDiags[profile.id] || { diag: null, loading: false, error: null };
                        const { diag, loading, error } = state;
                        const nodeUserCount = typeof diag?.userCount === 'number'
                            ? diag.userCount
                            : (Array.isArray(fleetNodeData?.[profile.id]?.members)
                                ? fleetNodeData[profile.id].members.length
                                : undefined);

                        return (
                            <div
                                key={profile.id}
                                className={`bg-nature-900/80 border rounded-2xl p-5 space-y-4 shadow-xl transition-all relative overflow-hidden ${
                                    isSelected
                                        ? 'border-terra-500/80 ring-1 ring-terra-500/30'
                                        : 'border-nature-800 hover:border-nature-700'
                                }`}
                            >
                                {/* Node Header */}
                                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-nature-800/80 pb-3">
                                    <div className="flex items-center gap-3">
                                        <span className="relative flex h-3 w-3 shrink-0">
                                            {diag && !error ? (
                                                <>
                                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                                    <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
                                                </>
                                            ) : error ? (
                                                <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500"></span>
                                            ) : (
                                                <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500 animate-pulse"></span>
                                            )}
                                        </span>
                                        <div>
                                            <div className="flex items-center gap-2">
                                                <h4 className="text-base font-bold text-white m-0">{profile.name}</h4>
                                                {isSelected && (
                                                    <span className="px-2 py-0.5 rounded bg-terra-500/20 text-terra-300 text-[10px] font-mono font-bold border border-terra-500/30">
                                                        PRIMARY TARGET
                                                    </span>
                                                )}
                                            </div>
                                            <code className="text-xs text-sky-400 font-mono block mt-0.5">
                                                {profile.url}
                                            </code>
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={() => onEditNode(profile)}
                                            className="px-3.5 py-2 rounded-xl bg-nature-800 hover:bg-terra-500/30 text-white font-bold transition-all border border-nature-700 flex items-center gap-2 text-xs shadow-sm active:scale-95"
                                            title="Configure Node Credentials & Admin Password"
                                        >
                                            <span className="text-base">⚙️</span>
                                            <span>Node Settings</span>
                                        </button>
                                        <button
                                            onClick={() => {
                                                onSelectNode(profile.id);
                                                if (onInspectNodeThreats) onInspectNodeThreats(profile.id);
                                            }}
                                            className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all ${
                                                isSelected
                                                    ? 'bg-terra-500 text-white shadow-sm'
                                                    : 'bg-nature-800 hover:bg-nature-700 text-nature-200 border border-nature-700'
                                            }`}
                                        >
                                            {isSelected ? '✓ Active Node' : 'Select Node'}
                                        </button>
                                    </div>
                                </div>

                                {/* Node Telemetry Grid */}
                                {error ? (
                                    <div className="p-4 rounded-xl bg-red-950/40 border border-red-800 text-red-300 text-xs flex items-center justify-between gap-3 font-mono">
                                        <div className="flex items-center gap-2">
                                            <span>❌ Unreachable: {error}</span>
                                        </div>
                                        <button
                                            onClick={() => onEditNode(profile)}
                                            className="px-2.5 py-1 rounded bg-red-900/40 hover:bg-red-900/60 text-red-200 text-[11px] font-sans font-bold border border-red-800 transition-all"
                                        >
                                            ⚙️ Update Password
                                        </button>
                                    </div>
                                ) : loading && !diag ? (
                                    <div className="p-6 text-center text-nature-400 text-xs italic">
                                        Connecting and fetching telemetry...
                                    </div>
                                ) : diag ? (
                                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3.5 text-xs font-sans">
                                        <div className="bg-nature-950/60 border border-nature-800/80 rounded-xl p-3.5 space-y-1">
                                            <span className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400 block">Standing</span>
                                            <div className="text-lg font-bold text-emerald-400 font-mono">
                                                {diag.status.toUpperCase()}
                                            </div>
                                            <span className="text-[11px] text-nature-400 truncate block">
                                                {diag.communityName || 'BeanPool Node'}
                                            </span>
                                        </div>

                                        <div className="bg-nature-950/60 border border-nature-800/80 rounded-xl p-3.5 space-y-1">
                                            <span className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400 block">Registered Users</span>
                                            <div className="text-lg font-bold text-indigo-400 font-mono">
                                                {typeof nodeUserCount === 'number' ? `${nodeUserCount} Users` : 'N/A'}
                                            </div>
                                            <span className="text-[11px] text-nature-400 block">Active registered members</span>
                                        </div>

                                        <div className="bg-nature-950/60 border border-nature-800/80 rounded-xl p-3.5 space-y-1">
                                            <span className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400 block">Process Uptime</span>
                                            <div className="text-lg font-bold text-white font-mono">
                                                {Math.floor(diag.uptimeSeconds / 3600)}h {Math.floor((diag.uptimeSeconds % 3600) / 60)}m {diag.uptimeSeconds % 60}s
                                            </div>
                                            <span className="text-[11px] text-nature-400 block">Active server thread</span>
                                        </div>

                                        <div className="bg-nature-950/60 border border-nature-800/80 rounded-xl p-3.5 space-y-1">
                                            <span className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400 block">Mesh Streams</span>
                                            <div className="text-lg font-bold text-sky-400 font-mono">
                                                {diag.activeWsConnections} WS / {diag.p2pActivePeers} P2P
                                            </div>
                                            <span className="text-[11px] text-nature-400 block">Live WebSocket & Peers</span>
                                        </div>

                                        <div className="bg-nature-950/60 border border-nature-800/80 rounded-xl p-3.5 space-y-1">
                                            <span className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400 block">SQLite Storage</span>
                                            <div className="text-lg font-bold text-amber-400 font-mono">
                                                {(diag.dbSizeBytes / (1024 * 1024)).toFixed(2)} MB
                                            </div>
                                            <span className="text-[11px] text-nature-400 block">
                                                WAL: {(diag.walSizeBytes / 1024).toFixed(1)} KB
                                            </span>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="p-4 text-center text-nature-500 text-xs">
                                        No telemetry data available.
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
