import React from 'react';
import type { NodeProfile } from '../../lib/profiles';

export type TabId = 'overview' | 'gateway' | 'members' | 'topology' | 'invites' | 'logs' | 'ai';

export type NodeHealthStatus = 'online' | 'warning' | 'critical' | 'alert' | 'offline' | 'loading';

export interface AlertCounts {
    critical: number;
    warning: number;
}

interface FleetSidebarProps {
    profiles: NodeProfile[];
    activeProfileId: string;
    onSelectNode: (id: string) => void;
    onOpenAddModal: () => void;
    onEditNode: (node: NodeProfile) => void;
    onRemoveNode: (id: string) => void;
    activeTab: TabId;
    onSelectTab: (tab: TabId) => void;
    nodeHealthMap?: Record<string, NodeHealthStatus>;
    tabAlertCounts?: Partial<Record<TabId, AlertCounts>>;
}

export function FleetSidebar({
    profiles,
    activeProfileId,
    onSelectNode,
    onOpenAddModal,
    onEditNode,
    onRemoveNode,
    activeTab,
    onSelectTab,
    nodeHealthMap = {},
    tabAlertCounts = {},
}: FleetSidebarProps) {
    const navItems: { id: TabId; label: string; icon: string; badge?: string }[] = [
        { id: 'overview', label: 'Fleet Telemetry', icon: '📊' },
        { id: 'gateway', label: 'Gateway Security', icon: '🛡️' },
        { id: 'members', label: 'Trust & Members', icon: '👥' },
        { id: 'topology', label: 'Replication & Backups', icon: '🗄️' },
        { id: 'invites', label: 'Invites & Onboarding', icon: '🎫' },
        { id: 'logs', label: 'System Streamer', icon: '📜' },
        { id: 'ai', label: 'Sovereign AI Copilot', icon: '🤖', badge: 'PRO' },
    ];

    return (
        <aside className="w-72 bg-nature-900 border-r border-nature-800 flex flex-col shrink-0 h-screen sticky top-0 font-sans z-30 select-none">
            {/* Header Brand */}
            <div className="p-5 border-b border-nature-800/80 flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-terra-600 to-terra-400 flex items-center justify-center text-xl shadow-lg shadow-terra-950/40 border border-terra-300/20">
                        🌱
                    </div>
                    <div>
                        <h1 className="text-base font-extrabold tracking-tight text-white m-0 leading-tight">
                            BeanPool
                        </h1>
                        <p className="text-[11px] font-semibold text-terra-400 m-0">Fleet Manager v1.2</p>
                    </div>
                </div>
            </div>

            {/* Navigation Tabs */}
            <div className="px-3 py-4 space-y-1">
                <div className="px-3 pb-2 text-[10px] font-extrabold uppercase tracking-wider text-nature-400">
                    Control Plane Navigation
                </div>
                {navItems.map((item) => {
                    const isActive = activeTab === item.id;
                    const counts = tabAlertCounts[item.id] || { critical: 0, warning: 0 };
                    const hasCounts = counts.critical > 0 || counts.warning > 0;

                    return (
                        <button
                            key={item.id}
                            onClick={() => onSelectTab(item.id)}
                            className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition-all ${
                                isActive
                                    ? 'bg-terra-500/15 text-white border border-terra-500/40 shadow-sm font-bold'
                                    : 'text-nature-300 hover:text-white hover:bg-nature-800/50 border border-transparent'
                            }`}
                        >
                            <div className="flex items-center gap-2.5 min-w-0">
                                <span className="text-sm shrink-0">{item.icon}</span>
                                <span className="truncate">{item.label}</span>
                            </div>

                            <div className="flex items-center gap-1 shrink-0">
                                {counts.critical > 0 && (
                                    <span
                                        className="px-1.5 py-0.5 rounded-full bg-red-600 text-white text-[9px] font-mono font-bold animate-pulse shadow-sm flex items-center gap-0.5"
                                        title={`${counts.critical} Critical Fleet Alerts`}
                                    >
                                        <span>🚨</span>
                                        <span>{counts.critical}</span>
                                    </span>
                                )}
                                {counts.warning > 0 && (
                                    <span
                                        className="px-1.5 py-0.5 rounded-full bg-amber-500 text-black text-[9px] font-mono font-bold shadow-sm flex items-center gap-0.5"
                                        title={`${counts.warning} Fleet Warnings`}
                                    >
                                        <span>⚠️</span>
                                        <span>{counts.warning}</span>
                                    </span>
                                )}
                                {item.badge && !hasCounts && (
                                    <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-terra-500/20 text-terra-300 border border-terra-500/30">
                                        {item.badge}
                                    </span>
                                )}
                            </div>
                        </button>
                    );
                })}
            </div>

            {/* Connected Fleet Panel (All Nodes Visible) */}
            <div className="flex-1 flex flex-col min-h-0 border-t border-nature-800/80 px-3 py-4">
                <div className="flex items-center justify-between px-3 pb-2.5">
                    <span className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400">
                        Connected Fleet ({profiles.length})
                    </span>
                    <button
                        onClick={onOpenAddModal}
                        className="px-2 py-1 rounded-lg bg-terra-500/20 hover:bg-terra-500/30 text-terra-300 text-[11px] font-bold transition-all border border-terra-500/30"
                        title="Connect New Sovereign Node"
                    >
                        + Add Node
                    </button>
                </div>

                {/* Scrollable Node Cards */}
                <div className="flex-1 overflow-y-auto space-y-2 pr-1 custom-scrollbar">
                    {profiles.map((p) => {
                        const isSelected = p.id === activeProfileId;
                        const health = nodeHealthMap[p.id] || 'loading';

                        return (
                            <div
                                key={p.id}
                                onClick={() => onSelectNode(p.id)}
                                className={`p-3 rounded-xl cursor-pointer transition-all border relative group ${
                                    health === 'critical' || health === 'alert'
                                        ? 'bg-red-950/20 border-red-800/80 ring-1 ring-red-500/40 shadow-lg'
                                        : health === 'warning'
                                        ? 'bg-amber-950/20 border-amber-800/80 ring-1 ring-amber-500/40'
                                        : isSelected
                                        ? 'bg-nature-950/90 border-terra-500/60 shadow-md ring-1 ring-terra-500/30'
                                        : 'bg-nature-950/40 border-nature-800/80 hover:border-nature-700 hover:bg-nature-950/60'
                                }`}
                            >
                                <div className="flex items-start justify-between gap-2">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <span className="relative flex h-2.5 w-2.5 shrink-0">
                                            {health === 'critical' || health === 'alert' ? (
                                                <>
                                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                                                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500"></span>
                                                </>
                                            ) : health === 'warning' ? (
                                                <>
                                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                                                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500"></span>
                                                </>
                                            ) : health === 'online' ? (
                                                <>
                                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                                                </>
                                            ) : health === 'offline' ? (
                                                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500"></span>
                                            ) : (
                                                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500 animate-pulse"></span>
                                            )}
                                        </span>
                                        <span className="text-xs font-bold text-white truncate">{p.name}</span>
                                    </div>

                                    <div className="flex items-center gap-1.5 ml-auto">
                                        {profiles.length > 1 && (
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    onRemoveNode(p.id);
                                                }}
                                                className="opacity-0 group-hover:opacity-100 text-nature-500 hover:text-red-400 transition-opacity p-0.5 text-[11px]"
                                                title="Remove Node Profile"
                                            >
                                                ✕
                                            </button>
                                        )}
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onEditNode(p);
                                            }}
                                            className="text-nature-400 hover:text-white transition-all transform hover:rotate-45 text-base p-0 border-none bg-transparent focus:outline-none"
                                            title="Configure Node Credentials & Admin Password"
                                        >
                                            ⚙️
                                        </button>
                                    </div>
                                </div>

                                <div className="mt-1.5 flex items-center justify-between text-[10px] font-mono text-nature-400 truncate">
                                    <span className="truncate">{p.url.replace(/^https?:\/\//, '')}</span>
                                    {health === 'critical' || health === 'alert' ? (
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onSelectNode(p.id);
                                                onSelectTab('members');
                                            }}
                                            className="shrink-0 px-1.5 py-0.2 rounded bg-red-900/80 hover:bg-red-800 text-red-200 text-[9px] font-sans font-bold border border-red-700 animate-pulse transition-all cursor-pointer"
                                            title="Click to jump directly to Security Threat Inspector"
                                        >
                                            🚨 ALERT (Inspect)
                                        </button>
                                    ) : health === 'warning' ? (
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onSelectNode(p.id);
                                                onSelectTab('members');
                                            }}
                                            className="shrink-0 px-1.5 py-0.2 rounded bg-amber-900/80 hover:bg-amber-800 text-amber-200 text-[9px] font-sans font-bold border border-amber-700 transition-all cursor-pointer"
                                            title="Click to inspect Node Warnings"
                                        >
                                            ⚠️ WARN (Inspect)
                                        </button>
                                    ) : isSelected && (
                                        <span className="shrink-0 px-1.5 py-0.2 rounded bg-terra-500/20 text-terra-300 text-[9px] font-sans font-bold">
                                            ACTIVE
                                        </span>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Footer Status */}
            <div className="p-3 border-t border-nature-800/80 bg-nature-950/60 text-[11px] text-nature-400 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                    <span>Decoupled API Client</span>
                </div>
                <span className="font-mono text-[10px] text-nature-500">Node API</span>
            </div>
        </aside>
    );
}
