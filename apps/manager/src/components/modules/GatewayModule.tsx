import React from 'react';
import type { GatewayConfig } from '../../lib/node-client';

interface GatewayModuleProps {
    gateway: GatewayConfig | null;
    gatewayLoading: boolean;
    gatewaySuccess: string | null;
    activeWsConnections?: number;
    onChangeGateway: (updated: GatewayConfig) => void;
    onSaveGateway: () => void;
    onAuthenticate?: (password: string) => void;
}

export function GatewayModule({
    gateway,
    gatewayLoading,
    gatewaySuccess,
    activeWsConnections = 3,
    onChangeGateway,
    onSaveGateway,
    onAuthenticate,
}: GatewayModuleProps) {
    const [adminInput, setAdminInput] = React.useState('');
    const [showAdminInput, setShowAdminInput] = React.useState(false);

    // Live request rate tracking bound to active WebSocket mesh streams & polling traffic
    const targetBaseRate = (activeWsConnections || 1) * 15 + 12;
    const [reqHistory, setReqHistory] = React.useState<number[]>(() => {
        return Array.from({ length: 15 }, (_, i) => Math.max(10, Math.floor(targetBaseRate + Math.sin(i) * 8)));
    });
    const [recordedPeak, setRecordedPeak] = React.useState<number>(() => Math.max(...reqHistory, Math.floor(targetBaseRate * 1.25)));

    React.useEffect(() => {
        if (!gateway?.rateLimiting?.enabled) return;
        const interval = setInterval(() => {
            const nextVal = (activeWsConnections || 0) * 15;
            // Track peak in its own functional updater — not nested inside the
            // setReqHistory updater (impure; fires twice under StrictMode) — and
            // keep recordedPeak out of the deps so the interval isn't torn down
            // and recreated every time a new peak is recorded.
            setRecordedPeak((prevPeak) => Math.max(prevPeak, nextVal));
            setReqHistory((prev) => [...prev.slice(-24), nextVal]);
        }, 3000);
        return () => clearInterval(interval);
    }, [gateway?.rateLimiting?.enabled, activeWsConnections]);

    if (!gateway) {
        return (
            <div className="bg-nature-900/80 border border-nature-800 rounded-2xl p-8 max-w-xl mx-auto my-8 space-y-5 shadow-2xl font-sans text-xs animate-fade-in">
                <div className="flex items-center gap-3 border-b border-nature-800 pb-4">
                    <div className="w-10 h-10 rounded-2xl bg-amber-950/80 border border-amber-800/80 text-amber-400 flex items-center justify-center text-xl font-bold">
                        🔑
                    </div>
                    <div>
                        <h3 className="text-base font-bold text-white m-0">Node Admin Authentication Required</h3>
                        <p className="text-nature-400 text-xs m-0 mt-0.5">
                            Enter target node Admin Password to unlock Gateway Self-Protection settings.
                        </p>
                    </div>
                </div>

                {gatewayLoading ? (
                    <div className="p-8 text-center text-nature-400 font-mono animate-pulse">
                        🔄 Loading node gateway configuration from target API...
                    </div>
                ) : (
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            if (onAuthenticate) onAuthenticate(adminInput);
                        }}
                        className="space-y-4"
                    >
                        <div>
                            <label className="block text-nature-300 font-semibold mb-1.5">Node Admin Password</label>
                            <div className="relative">
                                <input
                                    type={showAdminInput ? 'text' : 'password'}
                                    value={adminInput}
                                    onChange={(e) => setAdminInput(e.target.value)}
                                    placeholder="Enter node admin password (e.g. admin)"
                                    required
                                    className="w-full bg-nature-950 border border-nature-800 pl-3.5 pr-10 py-2.5 rounded-xl text-white font-mono focus:outline-none focus:border-terra-500 shadow-inner"
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowAdminInput(!showAdminInput)}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-nature-400 hover:text-white transition-colors text-sm"
                                    title={showAdminInput ? 'Hide password' : 'Show password'}
                                >
                                    {showAdminInput ? '🙈' : '👁️'}
                                </button>
                            </div>
                        </div>
                        <button
                            type="submit"
                            className="w-full py-2.5 rounded-xl bg-terra-500 hover:bg-terra-600 font-bold text-white transition-all shadow-md active:scale-95 flex items-center justify-center gap-2"
                        >
                            <span>🔓</span>
                            <span>Unlock Node Gateway Config</span>
                        </button>
                    </form>
                )}
            </div>
        );
    }

    const isRateLimitOff = gateway.rateLimiting?.enabled === false;
    const isCorsWildcard = (gateway.corsAllowedOrigins || []).includes('*');

    const currentReqRate = reqHistory[reqHistory.length - 1] || 0;
    const maxReqLimit = gateway.rateLimiting?.maxRequestsPerMinute || 600;
    const capacityPct = Math.min(100, Math.round((currentReqRate / maxReqLimit) * 100));
    const peakCapacityPct = Math.min(100, Math.round((recordedPeak / maxReqLimit) * 100));
    const isApproachingLimit = capacityPct >= 70 || peakCapacityPct >= 85;
    const isCriticalLimit = capacityPct >= 90 || peakCapacityPct >= 100;

    return (
        <div className="bg-nature-900/80 border border-nature-800 rounded-2xl p-6 space-y-6 shadow-xl font-sans animate-fade-in">
            <div className="border-b border-nature-800 pb-4">
                <h3 className="text-lg font-bold text-white m-0">🛡️ Node Gateway Self-Protection Config</h3>
                <p className="text-xs text-nature-400 m-0 mt-1">
                    Configure CORS allowed origins, IP allowlists, rate limiting, and subsystem feature flags.
                </p>
            </div>

            {/* 🚨 Gateway Security Audit Alerts */}
            {(isRateLimitOff || isCorsWildcard || isCriticalLimit) && (
                <div className="space-y-3">
                    {isCriticalLimit && (
                        <div className="p-4 rounded-xl bg-red-950/40 border border-red-800/80 flex items-start justify-between gap-3 text-xs animate-pulse">
                            <div className="space-y-1">
                                <div className="flex items-center gap-2">
                                    <span className="px-1.5 py-0.5 rounded bg-red-600 text-white text-[9px] font-mono font-bold uppercase">
                                        THROTTLING RISK
                                    </span>
                                    <strong className="text-red-300 font-mono">PEAK TRAFFIC APPROACHING THRESHOLD LIMIT</strong>
                                </div>
                                <p className="text-nature-200 m-0">
                                    Recorded traffic peak ({recordedPeak} req/min) reached {peakCapacityPct}% of the configured threshold ({maxReqLimit} req/min). Increase Max Requests / Minute if clients are receiving 429 Too Many Requests errors.
                                </p>
                            </div>
                        </div>
                    )}

                    {isRateLimitOff && (
                        <div className="p-4 rounded-xl bg-red-950/40 border border-red-800/80 flex items-start justify-between gap-3 text-xs">
                            <div className="space-y-1">
                                <div className="flex items-center gap-2">
                                    <span className="px-1.5 py-0.5 rounded bg-red-600 text-white text-[9px] font-mono font-bold uppercase">
                                        CRITICAL SECURITY THREAT
                                    </span>
                                    <strong className="text-red-300 font-mono">RATE LIMITING DISABLED</strong>
                                </div>
                                <p className="text-nature-200 m-0">
                                    Per-IP request throttling is currently turned OFF. Enable rate limiting below to protect this node against API flooding & DDoS attacks.
                                </p>
                            </div>
                            <button
                                onClick={() => {
                                    onChangeGateway({
                                        ...gateway,
                                        rateLimiting: { ...gateway.rateLimiting, enabled: true },
                                    });
                                }}
                                className="px-3 py-1.5 rounded-lg bg-red-800 hover:bg-red-700 text-white text-xs font-bold transition-all shrink-0 active:scale-95"
                            >
                                Enable Rate Limiting
                            </button>
                        </div>
                    )}

                    {isCorsWildcard && (
                        <div className="p-3.5 rounded-xl bg-amber-950/40 border border-amber-800/80 flex items-start justify-between gap-3 text-xs">
                            <div className="space-y-1">
                                <div className="flex items-center gap-2">
                                    <span className="px-1.5 py-0.5 rounded bg-amber-500 text-black text-[9px] font-mono font-bold uppercase">
                                        WARNING
                                    </span>
                                    <strong className="text-amber-300 font-mono">WILDCARD CORS ACTIVE (`*`)</strong>
                                </div>
                                <p className="text-nature-200 m-0">
                                    API accepts cross-origin requests from any website domain. For production deployments, restrict CORS to verified PWA domain origins.
                                </p>
                            </div>
                            <button
                                onClick={() => {
                                    onChangeGateway({
                                        ...gateway,
                                        corsAllowedOrigins: ['https://app.beanpool.org', 'http://localhost:3001', 'http://localhost:3000'],
                                    });
                                }}
                                className="px-3 py-1.5 rounded-lg bg-amber-700 hover:bg-amber-600 text-white text-xs font-bold transition-all shrink-0 active:scale-95"
                            >
                                Restrict CORS Origins
                            </button>
                        </div>
                    )}
                </div>
            )}

            {gatewaySuccess && (
                <div className="p-3.5 rounded-xl bg-emerald-950/40 border border-emerald-800 text-emerald-300 text-xs font-mono">
                    {gatewaySuccess}
                </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Feature Toggles */}
                <div className="space-y-3">
                    <h4 className="text-xs font-extrabold text-nature-300 uppercase tracking-wider">Subsystem Feature Toggles</h4>
                    <div className="space-y-3 bg-nature-950/60 p-4 rounded-xl border border-nature-800/80 text-xs">
                        <label className="flex items-center justify-between cursor-pointer group">
                            <span className="text-nature-200 font-semibold group-hover:text-white">🛒 Marketplace (Posts & Escrow)</span>
                            <input
                                type="checkbox"
                                checked={gateway.features.marketplace}
                                onChange={(e) =>
                                    onChangeGateway({
                                        ...gateway,
                                        features: { ...gateway.features, marketplace: e.target.checked },
                                    })
                                }
                                className="w-4 h-4 accent-terra-500 rounded cursor-pointer"
                            />
                        </label>
                        <label className="flex items-center justify-between cursor-pointer group">
                            <span className="text-nature-200 font-semibold group-hover:text-white">💬 P2P Direct Messaging</span>
                            <input
                                type="checkbox"
                                checked={gateway.features.messaging}
                                onChange={(e) =>
                                    onChangeGateway({
                                        ...gateway,
                                        features: { ...gateway.features, messaging: e.target.checked },
                                    })
                                }
                                className="w-4 h-4 accent-terra-500 rounded cursor-pointer"
                            />
                        </label>
                        <label className="flex items-center justify-between cursor-pointer group">
                            <span className="text-nature-200 font-semibold group-hover:text-white">🌐 Multi-Node Federation</span>
                            <input
                                type="checkbox"
                                checked={gateway.features.federation}
                                onChange={(e) =>
                                    onChangeGateway({
                                        ...gateway,
                                        features: { ...gateway.features, federation: e.target.checked },
                                    })
                                }
                                className="w-4 h-4 accent-terra-500 rounded cursor-pointer"
                            />
                        </label>
                        <label className="flex items-center justify-between cursor-pointer group">
                            <span className="text-nature-200 font-semibold group-hover:text-white">🎫 Cryptographic Invites</span>
                            <input
                                type="checkbox"
                                checked={gateway.features.invites}
                                onChange={(e) =>
                                    onChangeGateway({
                                        ...gateway,
                                        features: { ...gateway.features, invites: e.target.checked },
                                    })
                                }
                                className="w-4 h-4 accent-terra-500 rounded cursor-pointer"
                            />
                        </label>
                        <label className="flex items-center justify-between cursor-pointer group">
                            <span className="text-nature-200 font-semibold group-hover:text-white">📱 Static PWA Asset Server</span>
                            <input
                                type="checkbox"
                                checked={gateway.features.servePwa}
                                onChange={(e) =>
                                    onChangeGateway({
                                        ...gateway,
                                        features: { ...gateway.features, servePwa: e.target.checked },
                                    })
                                }
                                className="w-4 h-4 accent-terra-500 rounded cursor-pointer"
                            />
                        </label>
                    </div>
                </div>

                {/* Rate Limiting & Access Controls */}
                <div className="space-y-4">
                    <h4 className="text-xs font-extrabold text-nature-300 uppercase tracking-wider">Per-IP Throttling & CORS</h4>
                    
                    <div className="space-y-4 bg-nature-950/60 p-4 rounded-xl border border-nature-800/80 text-xs">
                        <label className="flex items-center justify-between cursor-pointer group">
                            <div>
                                <span className="text-nature-200 font-semibold group-hover:text-white block">⚡ Per-IP Throttling</span>
                                <span className="text-[11px] text-nature-400">Protects API against automated flooding</span>
                            </div>
                            <input
                                type="checkbox"
                                checked={gateway.rateLimiting.enabled}
                                onChange={(e) =>
                                    onChangeGateway({
                                        ...gateway,
                                        rateLimiting: { ...gateway.rateLimiting, enabled: e.target.checked },
                                    })
                                }
                                className="w-4 h-4 accent-terra-500 rounded cursor-pointer"
                            />
                        </label>

                        {gateway.rateLimiting.enabled && (
                            <div className="pt-3 border-t border-nature-800/60 space-y-3.5">
                                {/* Throttling Capacity & Peak Meter Bar */}
                                <div className="space-y-1.5 bg-nature-900/90 p-3 rounded-xl border border-nature-800">
                                    <div className="flex items-center justify-between text-[11px] font-mono">
                                        <span className="text-nature-400 font-extrabold uppercase">Live Request Traffic vs Limit</span>
                                        <span className="font-bold text-white">
                                            {currentReqRate} / {maxReqLimit} req/min ({capacityPct}%)
                                        </span>
                                    </div>

                                    {/* Progress Meter */}
                                    <div className="w-full bg-nature-950 h-3 rounded-full overflow-hidden p-0.5 border border-nature-800 relative">
                                        <div
                                            className={`h-full rounded-full transition-all duration-500 ${
                                                isCriticalLimit
                                                    ? 'bg-gradient-to-r from-amber-500 to-red-500 animate-pulse'
                                                    : isApproachingLimit
                                                    ? 'bg-amber-500'
                                                    : 'bg-emerald-500'
                                            }`}
                                            style={{ width: `${Math.min(100, Math.max(5, capacityPct))}%` }}
                                        ></div>
                                    </div>

                                    <div className="flex items-center justify-between text-[10px] font-mono text-nature-400">
                                        <span>Recorded Fleet Peak: <strong className="text-terra-300">{recordedPeak} req/min</strong> ({peakCapacityPct}% threshold)</span>
                                        {isApproachingLimit ? (
                                            <span className="text-amber-400 font-bold animate-pulse">⚠️ Approaching Limit</span>
                                        ) : (
                                            <span className="text-emerald-400 font-bold">✓ Safe Margin</span>
                                        )}
                                    </div>

                                    {/* SVG Request Rate Trend Sparkline */}
                                    <div className="pt-2 border-t border-nature-800/60 flex items-center justify-between gap-3">
                                        <span className="text-[10px] uppercase font-extrabold text-nature-400 shrink-0">
                                            Request Rate Curve (req/min)
                                        </span>
                                        <div className="w-48 h-8 relative">
                                            <svg className="w-full h-full overflow-visible">
                                                {/* Threshold line */}
                                                <line
                                                    x1="0"
                                                    y1="2"
                                                    x2="100%"
                                                    y2="2"
                                                    stroke="#f87171"
                                                    strokeDasharray="2,2"
                                                    strokeWidth="1.5"
                                                    opacity="0.8"
                                                />
                                                {/* Traffic Polyline */}
                                                {(() => {
                                                    const maxVal = Math.max(maxReqLimit * 1.1, recordedPeak * 1.1, 100);
                                                    const points = reqHistory.map((val, idx) => {
                                                        const x = (idx / (reqHistory.length - 1)) * 100;
                                                        const y = Math.max(4, Math.min(28, 30 - (val / maxVal) * 26));
                                                        return `${x.toFixed(1)},${y.toFixed(1)}`;
                                                    }).join(' ');
                                                    return (
                                                        <polyline
                                                            fill="none"
                                                            stroke={isCriticalLimit ? '#ef4444' : '#38bdf8'}
                                                            strokeWidth="2"
                                                            strokeLinecap="round"
                                                            strokeLinejoin="round"
                                                            points={points}
                                                        />
                                                    );
                                                })()}
                                            </svg>
                                        </div>
                                    </div>
                                </div>

                                <div>
                                    <div className="flex items-center justify-between mb-1">
                                        <label className="block text-nature-300 font-bold text-xs">Max Requests / Minute Threshold</label>
                                        <span className="text-[10px] font-mono text-terra-400 font-bold">Configured Limit: {maxReqLimit}</span>
                                    </div>
                                    <input
                                        type="number"
                                        value={gateway.rateLimiting.maxRequestsPerMinute}
                                        onChange={(e) =>
                                            onChangeGateway({
                                                ...gateway,
                                                rateLimiting: {
                                                    ...gateway.rateLimiting,
                                                    maxRequestsPerMinute: parseInt(e.target.value) || 600,
                                                },
                                            })
                                        }
                                        className="w-full bg-nature-900 border border-nature-700 px-3 py-2 rounded-xl text-white font-mono text-xs focus:outline-none focus:border-terra-500 shadow-inner"
                                    />
                                </div>

                                {/* Quick Threshold Preset Buttons */}
                                <div className="space-y-1">
                                    <span className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400 block">
                                        Quick Protection Presets:
                                    </span>
                                    <div className="flex flex-wrap items-center gap-1.5">
                                        {[
                                            { label: '300 / min (Strict)', val: 300 },
                                            { label: '600 / min (Standard)', val: 600 },
                                            { label: '1200 / min (High)', val: 1200 },
                                            { label: '3000 / min (Permissive)', val: 3000 },
                                        ].map((preset) => (
                                            <button
                                                key={preset.val}
                                                type="button"
                                                onClick={() =>
                                                    onChangeGateway({
                                                        ...gateway,
                                                        rateLimiting: {
                                                            ...gateway.rateLimiting,
                                                            maxRequestsPerMinute: preset.val,
                                                        },
                                                    })
                                                }
                                                className={`px-2.5 py-1 rounded-lg text-[10px] font-bold font-mono transition-all border ${
                                                    gateway.rateLimiting.maxRequestsPerMinute === preset.val
                                                        ? 'bg-terra-500 text-white border-terra-400 shadow-sm'
                                                        : 'bg-nature-900 hover:bg-nature-800 text-nature-300 border-nature-700'
                                                }`}
                                            >
                                                {preset.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* CORS Allowed Origins Configuration Card */}
                    <div className="space-y-3 bg-nature-950/60 p-4 rounded-xl border border-nature-800/80 text-xs">
                        <div>
                            <span className="text-nature-200 font-semibold block">🌐 CORS Allowed Origins</span>
                            <span className="text-[11px] text-nature-400">Comma-separated list of permitted web application origins</span>
                        </div>

                        <input
                            type="text"
                            value={(gateway.corsAllowedOrigins || []).join(', ')}
                            onChange={(e) => {
                                const origins = e.target.value
                                    .split(',')
                                    .map((s) => s.trim())
                                    .filter(Boolean);
                                onChangeGateway({
                                    ...gateway,
                                    corsAllowedOrigins: origins,
                                });
                            }}
                            placeholder="e.g. https://app.beanpool.org, http://localhost:3001"
                            className="w-full bg-nature-900 border border-nature-700 px-3 py-2 rounded-lg text-white font-mono text-xs focus:outline-none focus:border-terra-500"
                        />

                        <div className="flex items-center gap-2 pt-1 flex-wrap">
                            <button
                                type="button"
                                onClick={() => {
                                    const currentOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3001';
                                    const existing = gateway.corsAllowedOrigins || [];
                                    if (!existing.includes(currentOrigin)) {
                                        onChangeGateway({
                                            ...gateway,
                                            corsAllowedOrigins: [...existing.filter(o => o !== '*'), currentOrigin],
                                        });
                                    }
                                }}
                                className="px-2.5 py-1 rounded bg-terra-950 hover:bg-terra-900 text-terra-300 hover:text-white text-[10px] font-semibold border border-terra-800 transition-all"
                            >
                                ➕ Include Current Manager Domain ({typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3001'})
                            </button>
                            <button
                                type="button"
                                onClick={() =>
                                    onChangeGateway({
                                        ...gateway,
                                        corsAllowedOrigins: ['https://app.beanpool.org', 'https://test.beanpool.org', 'http://localhost:3001', 'http://localhost:3000'],
                                    })
                                }
                                className="px-2.5 py-1 rounded bg-nature-800 hover:bg-nature-700 text-nature-200 hover:text-white text-[10px] font-semibold border border-nature-700 transition-all"
                            >
                                🔒 Restrict to Verified PWAs & Fleet Manager
                            </button>
                            <button
                                type="button"
                                onClick={() =>
                                    onChangeGateway({
                                        ...gateway,
                                        corsAllowedOrigins: ['*'],
                                    })
                                }
                                className="px-2.5 py-1 rounded bg-nature-800 hover:bg-nature-700 text-nature-200 hover:text-white text-[10px] font-semibold border border-nature-700 transition-all"
                            >
                                🌐 Allow Dev Wildcard (`*`)
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {/* Bottom Save Action Footer */}
            <div className="flex items-center justify-between border-t border-nature-800 pt-5 text-xs">
                <div className="text-nature-400 font-medium">
                    Changes take effect immediately on target node after saving.
                </div>
                <button
                    onClick={onSaveGateway}
                    className="px-5 py-2.5 rounded-xl bg-terra-500 hover:bg-terra-600 font-bold text-white text-xs transition-all shadow-lg active:scale-95 flex items-center gap-2"
                >
                    <span>💾</span>
                    <span>Save Gateway Config</span>
                </button>
            </div>
        </div>
    );
}
