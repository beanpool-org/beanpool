import React, { useState } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import type { DiagnosticsResponse } from '../../lib/node-client';

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

export interface AnalyticsModuleProps {
    profiles: NodeProfile[];
    activeProfileId: string;
    fleetDiags: Record<string, { diag: DiagnosticsResponse | null; loading: boolean; error: string | null }>;
    historyMap: Record<string, TelemetryHistoryPoint[]>;
    onSelectNode: (id: string) => void;
    onEditNode: (node: NodeProfile) => void;
    onRefreshFleet: () => void;
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

export function AnalyticsModule({
    profiles,
    activeProfileId,
    fleetDiags,
    historyMap,
    onSelectNode,
    onEditNode,
    onRefreshFleet,
}: AnalyticsModuleProps) {
    const [metricType, setMetricType] = useState<'cpu' | 'memory' | 'streams' | 'wal'>('memory');
    const [selectedTimeRange, setSelectedTimeRange] = useState<'live' | '5m' | '15m'>('live');

    const isGlobalLoading = Object.values(fleetDiags).some((d) => d?.loading);

    // Compute peak metrics across history
    let peakValue = 0;
    let peakNodeName = '';
    let peakNodeId = '';
    let peakThresholdBreached = false;
    let warningThresholdBreached = false;

    // Node peak statistics
    const nodePeakStats: Record<string, { current: number; peak: number; threshold: number; breached: boolean; warning: boolean }> = {};

    profiles.forEach((p) => {
        const points = historyMap[p.id] || [];
        let nodeCurrent = 0;
        let nodePeak = 0;
        let thresh = 80;

        points.forEach((pt) => {
            let val = 0;
            if (metricType === 'cpu') {
                val = pt.cpu;
                thresh = 80;
            } else if (metricType === 'memory') {
                val = pt.memMb;
                if (pt.memMb < 1500) {
                    thresh = pt.totalMemMb <= 2048 ? Math.round(pt.totalMemMb * 0.8) : 512;
                } else {
                    thresh = pt.totalMemMb > 4096 ? Math.round(pt.totalMemMb * 0.95) : Math.round(pt.totalMemMb * 0.8);
                }
            } else if (metricType === 'streams') {
                val = pt.ws + pt.p2p;
                thresh = 50;
            } else if (metricType === 'wal') {
                val = pt.walMb;
                thresh = 10; // 10MB WAL limit
            }

            nodeCurrent = val;
            if (val > nodePeak) nodePeak = val;

            if (val > peakValue) {
                peakValue = val;
                peakNodeName = p.name;
                peakNodeId = p.id;
            }

            if (val >= thresh) {
                peakThresholdBreached = true;
            } else if (val >= thresh * 0.85) {
                warningThresholdBreached = true;
            }
        });

        nodePeakStats[p.id] = {
            current: nodeCurrent,
            peak: nodePeak,
            threshold: thresh,
            breached: nodePeak >= thresh,
            warning: nodePeak >= thresh * 0.85 && nodePeak < thresh,
        };
    });

    return (
        <div className="space-y-6 animate-fade-in font-sans">
            {/* Header Banner */}
            <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                    <h2 className="text-xl font-bold text-white tracking-tight m-0 flex items-center gap-2.5">
                        <span>📈 Multi-Node Peak Threshold Analytics</span>
                        {peakThresholdBreached ? (
                            <span className="px-2.5 py-0.5 rounded-full bg-red-600/30 text-red-300 border border-red-500/50 text-xs font-mono font-bold animate-pulse flex items-center gap-1">
                                <span>🚨</span>
                                <span>CRITICAL PEAK DETECTED</span>
                            </span>
                        ) : warningThresholdBreached ? (
                            <span className="px-2.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40 text-xs font-mono font-bold flex items-center gap-1">
                                <span>⚠️</span>
                                <span>PEAK WARNING</span>
                            </span>
                        ) : (
                            <span className="px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-xs font-mono font-bold flex items-center gap-1">
                                <span>✅</span>
                                <span>THRESHOLDS NORMAL</span>
                            </span>
                        )}
                    </h2>
                    <p className="text-xs text-nature-400 m-0 mt-1">
                        Time-series trend graphs with alert threshold markers, peak monitor overlays, and hardware capacity analytics across all {profiles.length} sovereign nodes.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={onRefreshFleet}
                        disabled={isGlobalLoading}
                        className="px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all flex items-center gap-2 active:scale-95 shadow-md"
                    >
                        <span className={isGlobalLoading ? 'animate-spin' : ''}>🔄</span>
                        <span>{isGlobalLoading ? 'Refreshing Analytics...' : 'Refresh Analytics'}</span>
                    </button>
                </div>
            </div>

            {/* Peak Analytics At-a-Glance Ribbon */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs font-sans">
                <div className={`border rounded-2xl p-4 space-y-1 shadow-md transition-all ${
                    peakThresholdBreached
                        ? 'bg-red-950/30 border-red-800/80 ring-1 ring-red-500/40'
                        : 'bg-nature-900/90 border-nature-800'
                }`}>
                    <span className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400 block">
                        Recorded Fleet Peak ({metricType.toUpperCase()})
                    </span>
                    <div className="text-2xl font-black text-white font-mono flex items-center justify-between">
                        <span>
                            {metricType === 'cpu'
                                ? `${peakValue.toFixed(1)}%`
                                : metricType === 'memory'
                                ? `${peakValue.toFixed(0)} MB`
                                : metricType === 'wal'
                                ? `${peakValue.toFixed(2)} MB`
                                : `${peakValue} Streams`}
                        </span>
                        {peakThresholdBreached && <span className="text-lg">🚨</span>}
                    </div>
                    <span className="text-[11px] text-terra-400 font-semibold truncate block">
                        {peakNodeName ? `Peak Node: ${peakNodeName}` : 'All nodes quiet'}
                    </span>
                </div>

                <div className="bg-nature-900/90 border border-nature-800 rounded-2xl p-4 space-y-1 shadow-md">
                    <span className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400 block">
                        Threshold Exceeded Status
                    </span>
                    <div className="text-xl font-black font-mono">
                        {peakThresholdBreached ? (
                            <span className="text-red-400 flex items-center gap-1.5 animate-pulse">
                                <span>⚠️</span> Exceeded
                            </span>
                        ) : warningThresholdBreached ? (
                            <span className="text-amber-400 flex items-center gap-1.5">
                                <span>⚡</span> Near Limit
                            </span>
                        ) : (
                            <span className="text-emerald-400 flex items-center gap-1.5">
                                <span>🛡️</span> All Safe
                            </span>
                        )}
                    </div>
                    <span className="text-[11px] text-nature-400 font-semibold block">
                        {metricType === 'cpu'
                            ? 'Threshold: 80% CPU Load'
                            : metricType === 'memory'
                            ? 'Threshold: 80% System RAM'
                            : metricType === 'wal'
                            ? 'Threshold: 10.0 MB WAL'
                            : 'Threshold: 50 Streams'}
                    </span>
                </div>

                <div className="bg-nature-900/90 border border-nature-800 rounded-2xl p-4 space-y-1 shadow-md">
                    <span className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400 block">
                        Nodes Monitored
                    </span>
                    <div className="text-2xl font-black text-sky-400 font-mono">
                        {profiles.length} Sovereign Nodes
                    </div>
                    <span className="text-[11px] text-nature-400 font-semibold block">
                        Active telemetry stream listeners
                    </span>
                </div>

                <div className="bg-nature-900/90 border border-nature-800 rounded-2xl p-4 space-y-1 shadow-md">
                    <span className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400 block">
                        Time-Series Buffer
                    </span>
                    <div className="text-2xl font-black text-indigo-400 font-mono">
                        30 Snapshots
                    </div>
                    <span className="text-[11px] text-nature-400 font-semibold block">
                        Live 4s interval resolution
                    </span>
                </div>
            </div>

            {/* REAL-TIME TIME-SERIES TREND GRAPH & PEAK CONTROLS */}
            <div className="bg-nature-900/90 border border-nature-800 rounded-2xl p-5 space-y-4 shadow-xl">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-nature-800/80 pb-3">
                    <div className="flex items-center gap-3">
                        <span className="text-xl">📈</span>
                        <div>
                            <h3 className="text-sm font-extrabold text-white m-0 tracking-tight">
                                Live Telemetry & Peak Threshold Analytics
                            </h3>
                            <p className="text-[11px] text-nature-400 m-0">
                                Real-time overlay of hardware usage trends against safety alert thresholds.
                            </p>
                        </div>
                    </div>

                    {/* Metric Selectors */}
                    <div className="flex flex-wrap items-center gap-1.5 bg-nature-950 p-1 rounded-xl border border-nature-800">
                        <button
                            onClick={() => setMetricType('cpu')}
                            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                                metricType === 'cpu'
                                    ? 'bg-terra-500 text-white shadow'
                                    : 'text-nature-400 hover:text-white'
                            }`}
                        >
                            🖥️ CPU Load (%)
                        </button>
                        <button
                            onClick={() => setMetricType('memory')}
                            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                                metricType === 'memory'
                                    ? 'bg-terra-500 text-white shadow'
                                    : 'text-nature-400 hover:text-white'
                            }`}
                        >
                            🧠 Memory (MB)
                        </button>
                        <button
                            onClick={() => setMetricType('streams')}
                            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                                metricType === 'streams'
                                    ? 'bg-terra-500 text-white shadow'
                                    : 'text-nature-400 hover:text-white'
                            }`}
                        >
                            ⚡ Mesh Streams
                        </button>
                        <button
                            onClick={() => setMetricType('wal')}
                            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                                metricType === 'wal'
                                    ? 'bg-terra-500 text-white shadow'
                                    : 'text-nature-400 hover:text-white'
                            }`}
                        >
                            🗄️ SQLite WAL (MB)
                        </button>
                    </div>
                </div>

                {/* Peak Monitor Banner Bar */}
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 rounded-xl bg-nature-950/80 border border-nature-800 text-xs font-sans">
                    <div className="flex items-center gap-2">
                        <span className="text-nature-400 font-bold uppercase text-[10px] tracking-wider">RECORDED FLEET PEAK:</span>
                        <span className="font-mono font-extrabold text-white text-sm">
                            {metricType === 'cpu'
                                ? `${peakValue.toFixed(1)}%`
                                : metricType === 'memory'
                                ? `${peakValue.toFixed(0)} MB`
                                : metricType === 'wal'
                                ? `${peakValue.toFixed(2)} MB`
                                : `${peakValue} Streams`}
                        </span>
                        {peakNodeName && (
                            <span className="text-[11px] text-terra-400 font-semibold">({peakNodeName})</span>
                        )}
                    </div>

                    <div className="flex items-center gap-2">
                        {metricType === 'cpu' && (
                            <span className="text-[11px] text-nature-400">
                                🚨 Alert Threshold Marker: <span className="font-mono font-bold text-red-400">80% System Load</span>
                            </span>
                        )}
                        {metricType === 'memory' && (
                            <span className="text-[11px] text-nature-400">
                                🚨 Alert Threshold Marker: <span className="font-mono font-bold text-red-400">80% System RAM</span>
                            </span>
                        )}
                        {metricType === 'wal' && (
                            <span className="text-[11px] text-nature-400">
                                🚨 Alert Threshold Marker: <span className="font-mono font-bold text-red-400">10.0 MB WAL</span>
                            </span>
                        )}
                        {peakThresholdBreached && (
                            <span className="px-2 py-0.5 rounded bg-red-950 border border-red-800 text-red-300 text-[10px] font-mono font-bold animate-pulse">
                                ⚠️ THRESHOLD EXCEEDED
                            </span>
                        )}
                    </div>
                </div>

                {/* SVG Time-Series Chart */}
                <div className="relative w-full h-64 bg-nature-950/90 rounded-xl border border-nature-800/90 p-4 font-mono overflow-hidden flex flex-col justify-between">
                    <svg className="w-full h-full overflow-visible" viewBox="0 0 600 200" preserveAspectRatio="none">
                        {/* Grid lines & Y-Axis Scale Labels */}
                        {[0, 0.25, 0.5, 0.75, 1].map((pct, i) => {
                            let label = '';
                            let maxVal = 100;
                            if (metricType === 'cpu') maxVal = 100;
                            else if (metricType === 'memory') maxVal = 1024;
                            else if (metricType === 'wal') maxVal = 15;
                            else maxVal = 10;

                            if (metricType === 'cpu') label = `${Math.round(pct * 100)}%`;
                            else if (metricType === 'memory') label = `${Math.round(pct * maxVal)}M`;
                            else if (metricType === 'wal') label = `${(pct * maxVal).toFixed(1)}M`;
                            else label = `${Math.round(pct * maxVal)}`;

                            const yPos = 190 - pct * 170;

                            return (
                                <g key={i}>
                                    <line
                                        x1="45"
                                        y1={yPos}
                                        x2="595"
                                        y2={yPos}
                                        stroke="#1e293b"
                                        strokeDasharray="4,4"
                                        strokeWidth="1"
                                    />
                                    <text
                                        x="40"
                                        y={yPos + 4}
                                        fill="#64748b"
                                        fontSize="10"
                                        textAnchor="end"
                                        fontFamily="monospace"
                                        fontWeight="bold"
                                    >
                                        {label}
                                    </text>
                                </g>
                            );
                        })}

                        {/* Threshold Marker Line */}
                        {(metricType === 'cpu' || metricType === 'wal' || metricType === 'memory') && (() => {
                            let thresholdPct = 0.8;
                            let labelText = '80% Threshold';
                            if (metricType === 'wal') {
                                thresholdPct = 10 / Math.max(15, peakValue * 1.2);
                                labelText = '10 MB WAL Limit';
                            }

                            const yPos = 190 - Math.max(0.05, Math.min(0.95, thresholdPct)) * 170;

                            return (
                                <g>
                                    <line
                                        x1="45"
                                        y1={yPos}
                                        x2="595"
                                        y2={yPos}
                                        stroke="#ef4444"
                                        strokeDasharray="6,4"
                                        strokeWidth="2"
                                        opacity="0.85"
                                    />
                                    <text
                                        x="590"
                                        y={yPos - 5}
                                        fill="#f87171"
                                        fontSize="10"
                                        textAnchor="end"
                                        fontWeight="bold"
                                    >
                                        🚨 {labelText}
                                    </text>
                                </g>
                            );
                        })()}

                        {/* Polyline Curves per Node */}
                        {profiles.map((p, pIdx) => {
                            const points = historyMap[p.id] || [];
                            if (points.length < 2) return null;

                            const color = NODE_COLORS[pIdx % NODE_COLORS.length];
                            let maxVal = 100;
                            if (metricType === 'cpu') maxVal = 100;
                            else if (metricType === 'memory') maxVal = Math.max(...points.map((pt) => pt.totalMemMb || 1024), 500);
                            else if (metricType === 'streams') maxVal = Math.max(...points.map((pt) => pt.ws + pt.p2p), 5);
                            else if (metricType === 'wal') maxVal = Math.max(15, peakValue * 1.2);

                            const coords = points
                                .map((pt, idx) => {
                                    const x = 45 + (idx / (points.length - 1)) * 550;
                                    let rawVal = 0;
                                    if (metricType === 'cpu') rawVal = pt.cpu;
                                    else if (metricType === 'memory') rawVal = pt.memMb;
                                    else if (metricType === 'streams') rawVal = pt.ws + pt.p2p;
                                    else if (metricType === 'wal') rawVal = pt.walMb;

                                    const y = 190 - Math.max(0, Math.min(1, rawVal / maxVal)) * 170;
                                    return `${x.toFixed(1)},${y.toFixed(1)}`;
                                })
                                .join(' ');

                            return (
                                <g key={p.id}>
                                    <polyline
                                        fill="none"
                                        stroke={color}
                                        strokeWidth="2.5"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        points={coords}
                                        className="transition-all duration-300"
                                    />
                                </g>
                            );
                        })}
                    </svg>
                </div>

                {/* Node Color Legend Pills */}
                <div className="flex flex-wrap items-center gap-2.5 pt-1 text-xs">
                    {profiles.map((p, pIdx) => {
                        const color = NODE_COLORS[pIdx % NODE_COLORS.length];
                        const points = historyMap[p.id] || [];
                        const lastPt = points[points.length - 1];
                        let valStr = 'N/A';
                        if (lastPt) {
                            if (metricType === 'cpu') valStr = `${lastPt.cpu.toFixed(1)}%`;
                            else if (metricType === 'memory') valStr = `${lastPt.memMb.toFixed(0)}MB`;
                            else if (metricType === 'streams') valStr = `${lastPt.ws}W/${lastPt.p2p}P`;
                            else if (metricType === 'wal') valStr = `${lastPt.walMb.toFixed(2)}MB`;
                        }

                        const stat = nodePeakStats[p.id];
                        const isBreached = stat?.breached;

                        return (
                            <button
                                key={p.id}
                                onClick={() => onSelectNode(p.id)}
                                className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border transition-all ${
                                    isBreached
                                        ? 'bg-red-950/40 border-red-800 text-white ring-1 ring-red-500/50'
                                        : 'bg-nature-950 border-nature-800/80 hover:border-nature-700 text-white'
                                }`}
                            >
                                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }}></span>
                                <span className="font-bold text-[11px] truncate max-w-[120px]">{p.name}</span>
                                <span className="font-mono text-[11px] font-bold text-nature-300">{valStr}</span>
                                {isBreached && <span className="text-[10px] text-red-400 font-extrabold">🚨</span>}
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* NODE PEAK & THRESHOLD CAPACITY BREAKDOWN GRID */}
            <div className="space-y-4">
                <div className="flex items-center justify-between border-b border-nature-800/80 pb-3">
                    <h3 className="text-xs font-extrabold text-nature-300 uppercase tracking-wider m-0">
                        Node Capacity & Threshold Peak Breakdown
                    </h3>
                    <span className="text-xs text-nature-400 font-mono">
                        Active Metric: <strong className="text-white uppercase">{metricType}</strong>
                    </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    {profiles.map((p, pIdx) => {
                        const color = NODE_COLORS[pIdx % NODE_COLORS.length];
                        const stat = nodePeakStats[p.id] || { current: 0, peak: 0, threshold: 80, breached: false, warning: false };
                        const points = historyMap[p.id] || [];
                        const lastPt = points[points.length - 1];

                        const pct = Math.min(100, Math.round((stat.current / (stat.threshold || 1)) * 100));

                        return (
                            <div
                                key={p.id}
                                className={`bg-nature-900/90 border rounded-2xl p-4 space-y-3 shadow-md relative overflow-hidden transition-all ${
                                    stat.breached
                                        ? 'border-red-800 ring-1 ring-red-500/40 bg-red-950/10'
                                        : stat.warning
                                        ? 'border-amber-800/80 ring-1 ring-amber-500/30'
                                        : 'border-nature-800'
                                }`}
                            >
                                <div className="flex items-center justify-between gap-2">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: color }}></span>
                                        <h4 className="text-sm font-bold text-white truncate m-0">{p.name}</h4>
                                    </div>

                                    {stat.breached ? (
                                        <span className="px-2 py-0.5 rounded bg-red-600 text-white text-[9px] font-mono font-bold animate-pulse shrink-0">
                                            🚨 EXCEEDED
                                        </span>
                                    ) : stat.warning ? (
                                        <span className="px-2 py-0.5 rounded bg-amber-500 text-black text-[9px] font-mono font-bold shrink-0">
                                            ⚠️ WARNING
                                        </span>
                                    ) : (
                                        <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[9px] font-mono font-bold border border-emerald-500/30 shrink-0">
                                            HEALTHY
                                        </span>
                                    )}
                                </div>

                                {/* Metrics Breakdown */}
                                <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                                    <div className="bg-nature-950/80 rounded-xl p-2.5 border border-nature-800/80">
                                        <span className="text-[9px] font-extrabold uppercase text-nature-400 block">Live Metric</span>
                                        <span className="text-sm font-black text-white block">
                                            {metricType === 'cpu'
                                                ? `${stat.current.toFixed(1)}%`
                                                : metricType === 'memory'
                                                ? `${stat.current.toFixed(0)} MB`
                                                : metricType === 'wal'
                                                ? `${stat.current.toFixed(2)} MB`
                                                : `${stat.current}`}
                                        </span>
                                    </div>
                                    <div className="bg-nature-950/80 rounded-xl p-2.5 border border-nature-800/80">
                                        <span className="text-[9px] font-extrabold uppercase text-nature-400 block">Recorded Peak</span>
                                        <span className="text-sm font-black text-terra-400 block">
                                            {metricType === 'cpu'
                                                ? `${stat.peak.toFixed(1)}%`
                                                : metricType === 'memory'
                                                ? `${stat.peak.toFixed(0)} MB`
                                                : metricType === 'wal'
                                                ? `${stat.peak.toFixed(2)} MB`
                                                : `${stat.peak}`}
                                        </span>
                                    </div>
                                </div>

                                {/* Capacity Bar */}
                                <div className="space-y-1 font-sans">
                                    <div className="flex items-center justify-between text-[10px] text-nature-400 font-semibold">
                                        <span>Threshold Limit ({stat.threshold} {metricType === 'cpu' ? '%' : metricType === 'memory' ? 'MB' : 'MB'})</span>
                                        <span className={stat.breached ? 'text-red-400 font-bold' : 'text-nature-300'}>{pct}%</span>
                                    </div>
                                    <div className="w-full h-2 bg-nature-950 rounded-full overflow-hidden border border-nature-800">
                                        <div
                                            className={`h-full transition-all duration-500 rounded-full ${
                                                stat.breached
                                                    ? 'bg-red-500 shadow-sm shadow-red-500/50'
                                                    : stat.warning
                                                    ? 'bg-amber-500'
                                                    : 'bg-emerald-500'
                                            }`}
                                            style={{ width: `${Math.min(100, pct)}%` }}
                                        ></div>
                                    </div>
                                </div>

                                <div className="flex items-center justify-between pt-1">
                                    <button
                                        onClick={() => onSelectNode(p.id)}
                                        className="text-[11px] font-bold text-terra-400 hover:text-terra-300 transition-colors"
                                    >
                                        Target Node →
                                    </button>
                                    <button
                                        onClick={() => onEditNode(p)}
                                        className="text-[11px] text-nature-400 hover:text-white transition-colors"
                                    >
                                        ⚙️ Settings
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
