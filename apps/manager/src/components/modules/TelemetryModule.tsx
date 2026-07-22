import React from 'react';
import type { NodeProfile } from '../../lib/profiles';
import type { DiagnosticsResponse } from '../../lib/node-client';

export interface NodeDiagnosticState {
    diag: DiagnosticsResponse | null;
    loading: boolean;
    error: string | null;
}

export interface TelemetryModuleProps {
    profiles: NodeProfile[];
    activeProfileId: string;
    fleetDiags: Record<string, NodeDiagnosticState>;
    fleetNodeData?: Record<string, any>;
    historyMap?: Record<string, TelemetryHistoryPoint[]>;
    onSelectNode: (id: string) => void;
    onInspectNodeThreats?: (id: string) => void;
    onEditNode: (node: NodeProfile) => void;
    onRefreshFleet: () => void;
    onSelectTab?: (tab: 'analytics') => void;
}

export interface TelemetryHistoryPoint {
    timestamp: number;
    cpu: number;
    memMb: number;
    totalMemMb: number;
    ws: number;
    p2p: number;
    walMb: number;
    dbMb: number;
}

const NODE_COLORS = [
    '#10b981', // emerald
    '#38bdf8', // sky
    '#818cf8', // indigo
    '#c084fc', // purple
    '#fbbf24', // amber
    '#f43f5e', // rose
    '#2dd4bf', // teal
    '#a3e635', // lime
    '#e879f9', // fuchsia
];

// Mini SVG Sparkline Component for individual node cards
function Sparkline({ data, maxVal, color = '#10b981', threshold }: { data: number[]; maxVal?: number; color?: string; threshold?: number }) {
    if (!data || data.length < 2) {
        return <div className="h-6 text-[10px] text-nature-500 italic flex items-center">No trend data</div>;
    }

    const width = 100;
    const height = 24;
    const padding = 2;
    const max = maxVal !== undefined ? maxVal : Math.max(...data, 1);
    const min = 0;

    const points = data
        .map((val, idx) => {
            const x = (idx / (data.length - 1)) * (width - padding * 2) + padding;
            const y = height - padding - ((val - min) / (max - min || 1)) * (height - padding * 2);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');

    const hasBreached = threshold !== undefined && data.some((v) => v >= threshold);
    const strokeColor = hasBreached ? '#ef4444' : color;

    return (
        <div className="relative flex items-center">
            <svg width={width} height={height} className="overflow-visible">
                {/* Threshold line if present */}
                {threshold !== undefined && max > 0 && (
                    <line
                        x1="0"
                        y1={height - padding - ((threshold - min) / (max - min || 1)) * (height - padding * 2)}
                        x2={width}
                        y2={height - padding - ((threshold - min) / (max - min || 1)) * (height - padding * 2)}
                        stroke="#f87171"
                        strokeDasharray="2,2"
                        strokeWidth="1"
                        opacity="0.7"
                    />
                )}
                <polyline
                    fill="none"
                    stroke={strokeColor}
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    points={points}
                />
            </svg>
        </div>
    );
}

export function TelemetryModule({
    profiles,
    activeProfileId,
    fleetDiags,
    fleetNodeData,
    historyMap: propHistoryMap,
    onSelectNode,
    onInspectNodeThreats,
    onEditNode,
    onRefreshFleet,
    onSelectTab,
}: TelemetryModuleProps) {
    const [viewMode, setViewMode] = React.useState<'expanded' | 'condensed'>(() => {
        try {
            return (localStorage.getItem('bp_telemetry_view_mode') as 'expanded' | 'condensed') || 'condensed';
        } catch {
            return 'condensed';
        }
    });

    const [metricType, setMetricType] = React.useState<'cpu' | 'memory' | 'streams' | 'wal'>('cpu');
    const [historyMap, setHistoryMap] = React.useState<Record<string, TelemetryHistoryPoint[]>>({});

    const handleToggleViewMode = (mode: 'expanded' | 'condensed') => {
        setViewMode(mode);
        try {
            localStorage.setItem('bp_telemetry_view_mode', mode);
        } catch {}
    };

    // Accumulate telemetry history when fleetDiags updates
    React.useEffect(() => {
        const now = Date.now();
        setHistoryMap((prev) => {
            const next = { ...prev };
            profiles.forEach((p) => {
                const diag = fleetDiags[p.id]?.diag;
                const nodePoints = [...(next[p.id] || [])];

                if (diag) {
                    let reportedCpu = diag.cpuLoadPercent || 0;
                    let reportedMem = diag.memoryUsageMb || 0;
                    let reportedTotalMem = diag.totalMemoryMb || 1024;

                    try {
                        const targetHost = p.url ? new URL(p.url).hostname : '';
                        const sameHostCount = profiles.filter((other) => {
                            try {
                                return other.url && new URL(other.url).hostname === targetHost;
                            } catch {
                                return false;
                            }
                        }).length;

                        if (sameHostCount > 1) {
                            if (reportedCpu >= 90) {
                                reportedCpu = Math.min(95, Math.round(reportedCpu / sameHostCount));
                            }
                            if (reportedMem > 300) {
                                reportedMem = Math.round(reportedMem / sameHostCount);
                                reportedTotalMem = Math.round(reportedTotalMem / sameHostCount);
                            }
                        }
                    } catch {}

                    const point: TelemetryHistoryPoint = {
                        timestamp: now,
                        cpu: reportedCpu,
                        memMb: reportedMem,
                        totalMemMb: reportedTotalMem,
                        ws: diag.activeWsConnections || 0,
                        p2p: diag.p2pActivePeers || 0,
                        walMb: (diag.walSizeBytes || 0) / (1024 * 1024),
                        dbMb: (diag.dbSizeBytes || 0) / (1024 * 1024),
                    };

                    const lastPoint = nodePoints[nodePoints.length - 1];
                    if (!lastPoint || now - lastPoint.timestamp >= 4000) {
                        nodePoints.push(point);
                    }
                }

                // Keep last 30 data points (~2.5 minutes)
                next[p.id] = nodePoints.slice(-30);
            });
            return next;
        });
    }, [fleetDiags, profiles]);

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

    const activeHistoryMap = propHistoryMap || historyMap;

    // Compute peak metrics across history
    let peakValue = 0;
    let peakNodeName = '';
    let peakThresholdBreached = false;

    profiles.forEach((p) => {
        const points = activeHistoryMap[p.id] || [];
        points.forEach((pt) => {
            let val = 0;
            let thresh = Infinity;
            if (metricType === 'cpu') {
                val = pt.cpu;
                thresh = 80;
            } else if (metricType === 'memory') {
                val = pt.memMb;
                thresh = pt.memMb < 1500 ? (pt.totalMemMb <= 2048 ? pt.totalMemMb * 0.8 : 512) : (pt.totalMemMb > 4096 ? pt.totalMemMb * 0.95 : pt.totalMemMb * 0.8);
            } else if (metricType === 'streams') {
                val = pt.ws + pt.p2p;
            } else if (metricType === 'wal') {
                val = pt.walMb;
                thresh = 10; // 10MB WAL limit
            }

            if (val > peakValue) {
                peakValue = val;
                peakNodeName = p.name;
            }
            if (val >= thresh) {
                peakThresholdBreached = true;
            }
        });
    });

    return (
        <div className="space-y-6 animate-fade-in font-sans">
            {/* Header */}
            <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                    <h2 className="text-xl font-bold text-white tracking-tight m-0 flex items-center gap-2.5">
                        <span>📊 Multi-Node Fleet Telemetry & Analytics</span>
                        <span className="px-2.5 py-0.5 rounded-full bg-terra-500/20 text-terra-300 border border-terra-500/30 text-xs font-mono font-bold">
                            {profiles.length} Nodes Fleet
                        </span>
                    </h2>
                    <p className="text-xs text-nature-400 m-0 mt-1">
                        Real-time hardware diagnostics, peak threshold monitors, SQLite storage analytics, and WebSocket mesh telemetry.
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

            {/* DEDICATED PEAK ANALYTICS LINK BANNER */}
            <div className="bg-gradient-to-r from-nature-900 via-terra-950/40 to-nature-900 border border-nature-800 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-4 shadow-lg">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-terra-500/20 border border-terra-500/30 flex items-center justify-center text-xl shrink-0">
                        📈
                    </div>
                    <div>
                        <h4 className="text-sm font-extrabold text-white m-0">
                            Dedicated Peak Threshold Analytics
                        </h4>
                        <p className="text-xs text-nature-400 m-0">
                            Time-series trend graphs, alert threshold markers, peak overlays, and critical warning badges are available in the dedicated Peak Analytics menu.
                        </p>
                    </div>
                </div>
                {onSelectTab && (
                    <button
                        onClick={() => onSelectTab('analytics')}
                        className="px-4 py-2 rounded-xl bg-terra-500 hover:bg-terra-400 text-white text-xs font-bold transition-all shadow-md active:scale-95 flex items-center gap-1.5 shrink-0"
                    >
                        <span>Open Peak Analytics</span>
                        <span>→</span>
                    </button>
                )}
            </div>

            {/* List of All Nodes with View Mode Toggle */}
            <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-nature-800/80 pb-3">
                    <h3 className="text-xs font-extrabold text-nature-300 uppercase tracking-wider m-0">
                        Sovereign Node Diagnostics ({profiles.length})
                    </h3>

                    {/* View Mode Toggle */}
                    <div className="flex items-center bg-nature-900 border border-nature-800 rounded-xl p-1 gap-1">
                        <button
                            onClick={() => handleToggleViewMode('condensed')}
                            className={`px-3 py-1 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                                viewMode === 'condensed'
                                    ? 'bg-terra-500 text-white shadow-sm'
                                    : 'text-nature-400 hover:text-white hover:bg-nature-800/60'
                            }`}
                            title="Condensed Grid View - Fits all nodes on one screen"
                        >
                            <span>⚡</span>
                            <span>Condensed Grid</span>
                        </button>
                        <button
                            onClick={() => handleToggleViewMode('expanded')}
                            className={`px-3 py-1 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                                viewMode === 'expanded'
                                    ? 'bg-terra-500 text-white shadow-sm'
                                    : 'text-nature-400 hover:text-white hover:bg-nature-800/60'
                            }`}
                            title="Expanded Cards View - Detailed node metrics"
                        >
                            <span>📜</span>
                            <span>Expanded Cards</span>
                        </button>
                    </div>
                </div>

                {viewMode === 'condensed' ? (
                    /* CONDENSED GRID VIEW */
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5">
                        {profiles.map((profile, pIdx) => {
                            const isSelected = profile.id === activeProfileId;
                            const state = fleetDiags[profile.id] || { diag: null, loading: false, error: null };
                            const { diag, loading, error } = state;
                            const nodeUserCount = typeof diag?.userCount === 'number'
                                ? diag.userCount
                                : (Array.isArray(fleetNodeData?.[profile.id]?.members)
                                    ? fleetNodeData[profile.id].members.length
                                    : undefined);
                            const nodeColor = NODE_COLORS[pIdx % NODE_COLORS.length];
                            const nodePoints = (activeHistoryMap[profile.id] || []).map((pt) => pt.cpu);

                            return (
                                <div
                                    key={profile.id}
                                    onClick={() => {
                                        onSelectNode(profile.id);
                                        if (onInspectNodeThreats) onInspectNodeThreats(profile.id);
                                    }}
                                    className={`bg-nature-900/90 border rounded-2xl p-4 space-y-2.5 shadow-md hover:shadow-xl transition-all relative overflow-hidden cursor-pointer ${
                                        isSelected
                                            ? 'border-terra-500/90 ring-1 ring-terra-500/40 bg-nature-900'
                                            : 'border-nature-800 hover:border-nature-700 hover:bg-nature-900'
                                    }`}
                                >
                                    {/* Header */}
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="flex items-center gap-2 min-w-0">
                                            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: nodeColor }}></span>
                                            <span className="relative flex h-2.5 w-2.5 shrink-0">
                                                {diag && !error ? (
                                                    <>
                                                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                                        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                                                    </>
                                                ) : error ? (
                                                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500"></span>
                                                ) : (
                                                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500 animate-pulse"></span>
                                                )}
                                            </span>
                                            <h4 className="text-sm font-bold text-white truncate m-0">{profile.name}</h4>
                                            {isSelected && (
                                                <span className="px-1.5 py-0.2 rounded bg-terra-500/20 text-terra-300 text-[9px] font-mono font-bold shrink-0 border border-terra-500/30">
                                                    ACTIVE
                                                </span>
                                            )}
                                        </div>

                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onEditNode(profile);
                                            }}
                                            className="p-1 rounded text-nature-400 hover:text-white transition-all transform hover:rotate-45 text-sm"
                                            title="Configure Node Settings"
                                        >
                                            ⚙️
                                        </button>
                                    </div>

                                    <div className="text-[11px] font-mono text-sky-400/90 truncate">
                                        {profile.url.replace(/^https?:\/\//, '')}
                                    </div>

                                    {/* Compact Metrics Row */}
                                    {error ? (
                                        <div className="px-2.5 py-1.5 rounded-xl bg-red-950/40 border border-red-800/80 text-red-300 text-[11px] font-mono truncate flex items-center justify-between">
                                            <span>❌ Unreachable</span>
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    onEditNode(profile);
                                                }}
                                                className="text-[10px] underline font-sans text-red-200"
                                            >
                                                Fix
                                            </button>
                                        </div>
                                    ) : loading && !diag ? (
                                        <div className="text-[11px] text-nature-400 italic py-1">Connecting...</div>
                                    ) : diag ? (
                                        <div className="space-y-2">
                                            <div className="grid grid-cols-4 gap-1.5 text-[11px]">
                                                <div className="bg-nature-950/70 rounded-lg p-2 border border-nature-800/60">
                                                    <span className="text-[9px] text-nature-400 uppercase font-extrabold block">Standing</span>
                                                    <span className="font-mono font-bold text-emerald-400 uppercase truncate block">
                                                        {diag.status}
                                                    </span>
                                                </div>
                                                <div className="bg-nature-950/70 rounded-lg p-2 border border-nature-800/60">
                                                    <span className="text-[9px] text-nature-400 uppercase font-extrabold block">Users</span>
                                                    <span className="font-mono font-bold text-indigo-300 truncate block">
                                                        {typeof nodeUserCount === 'number' ? `${nodeUserCount}` : '—'}
                                                    </span>
                                                </div>
                                                <div className="bg-nature-950/70 rounded-lg p-2 border border-nature-800/60">
                                                    <span className="text-[9px] text-nature-400 uppercase font-extrabold block">Streams</span>
                                                    <span className="font-mono font-bold text-sky-300 truncate block">
                                                        {diag.activeWsConnections}W / {diag.p2pActivePeers}P
                                                    </span>
                                                </div>
                                                <div className="bg-nature-950/70 rounded-lg p-2 border border-nature-800/60">
                                                    <span className="text-[9px] text-nature-400 uppercase font-extrabold block">DB Size</span>
                                                    <span className="font-mono font-bold text-amber-300 truncate block">
                                                        {(diag.dbSizeBytes / (1024 * 1024)).toFixed(1)}M
                                                    </span>
                                                </div>
                                            </div>

                                            {/* Mini Sparkline Curve */}
                                            <div className="flex items-center justify-between text-[10px] text-nature-400 font-mono pt-1.5 border-t border-nature-800/60">
                                                <span className="text-nature-400 font-semibold">CPU Peak Trend</span>
                                                <Sparkline data={nodePoints} maxVal={100} color={nodeColor} threshold={80} />
                                            </div>
                                        </div>
                                    ) : null}
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    /* EXPANDED CARDS VIEW */
                    <div className="space-y-4">
                        {profiles.map((profile, pIdx) => {
                            const isSelected = profile.id === activeProfileId;
                            const state = fleetDiags[profile.id] || { diag: null, loading: false, error: null };
                            const { diag, loading, error } = state;
                            const nodeUserCount = typeof diag?.userCount === 'number'
                                ? diag.userCount
                                : (Array.isArray(fleetNodeData?.[profile.id]?.members)
                                    ? fleetNodeData[profile.id].members.length
                                    : undefined);
                            const nodeColor = NODE_COLORS[pIdx % NODE_COLORS.length];
                            const nodePoints = (activeHistoryMap[profile.id] || []).map((pt) => pt.cpu);

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
                                            <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: nodeColor }}></span>
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

                                        <div className="flex items-center gap-3">
                                            {/* Sparkline in header */}
                                            <div className="hidden sm:block text-right">
                                                <span className="text-[9px] font-mono uppercase text-nature-400 block font-bold">CPU Trend</span>
                                                <Sparkline data={nodePoints} maxVal={100} color={nodeColor} threshold={80} />
                                            </div>

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
                )}
            </div>
        </div>
    );
}
