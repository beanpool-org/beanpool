import React, { useState } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { IS_FLEET_MODE } from '../../lib/mode';
import { useManual } from '../manual/Manual';
import { SECTION_SUB_TABS, isSettingsSection } from '../../lib/sections';
import type { SidebarMode } from '../../lib/sidebar-mode';
import { ReturnLinks, type ReturnLinksValue } from './ReturnLinks';

export type TabId =
    | 'home'
    | 'people'
    | 'economy'
    | 'bulletin'
    | 'appliance'
    | 'overview'
    | 'analytics'
    | 'gateway'
    | 'members'
    | 'topology'
    | 'invites'
    | 'onboarding'
    | 'logs'
    | 'ai';

/**
 * `auth_required` is kept apart from `offline` because the two need different actions from
 * the operator: one is "the node is down", the other is "this manager has the wrong
 * password for a node that is up and answering". Collapsing them sent someone looking for
 * a network fault when the node was healthy.
 */
export type NodeHealthStatus = 'online' | 'warning' | 'critical' | 'alert' | 'offline' | 'auth_required' | 'loading';

/** The single-node Settings sections, in menu order. lib/manual.test.ts reads the ids from this list. */
export const singleNodeNavItems: { id: TabId; label: string; icon: string; badge?: string }[] = [
    { id: 'home', label: 'Home', icon: '⚡' },
    { id: 'people', label: 'People & Safety', icon: '👥' },
    { id: 'economy', label: 'Shared Projects & Economy', icon: '🏛️' },
    { id: 'bulletin', label: 'Bulletin & News', icon: '📢' },
    { id: 'appliance', label: 'Appliance & Data', icon: '⚙️' },
];

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
    onReorderNodes?: (fromIndex: number, toIndex: number) => void;
    activeTab: TabId;
    onSelectTab: (tab: TabId) => void;
    nodeHealthMap?: Record<string, NodeHealthStatus>;
    tabAlertCounts?: Partial<Record<TabId, AlertCounts>>;
    isFleetMode?: boolean;
    communityName?: string;
    onLogout?: () => void;
    /**
     * `rail` is the desktop sidebar (single-node Settings hides it below `lg`). `drawer` is the same menu in the phone
     * sheet: bigger targets, a Close button, and the current section's sub-tabs listed under it.
     */
    variant?: 'rail' | 'drawer';
    activeSubTab?: string;
    onSelectSubTab?: (tab: TabId, sub: string) => void;
    onClose?: () => void;
    /** The drawer steps aside for the manual (without a history step: the manual adds its own). */
    onBeforeManual?: () => void;
    /** Single-node Settings: back to where the member came from, and their profile (lib/came-from.ts). */
    returnLinks?: ReturnLinksValue;
    /**
     * Single-node Settings, `rail` only (lg and wider): full, an icon strip, or hidden (lib/sidebar-mode.ts).
     * `onCollapse` is the collapse button: full → icons → hidden. The ☰ that brings it back lives in App.
     */
    mode?: SidebarMode;
    onCollapse?: () => void;
}

export function FleetSidebar({
    profiles,
    activeProfileId,
    onSelectNode,
    onOpenAddModal,
    onEditNode,
    onRemoveNode,
    onReorderNodes,
    activeTab,
    onSelectTab,
    nodeHealthMap = {},
    tabAlertCounts = {},
    isFleetMode = IS_FLEET_MODE,
    communityName,
    onLogout,
    variant = 'rail',
    activeSubTab,
    onSelectSubTab,
    onClose,
    onBeforeManual,
    returnLinks,
    mode = 'full',
    onCollapse,
}: FleetSidebarProps) {
    const inDrawer = variant === 'drawer';
    const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
    const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
    const activeNode = profiles.find((p) => p.id === activeProfileId) || profiles[0];

    const multiServerItems: { id: TabId; label: string; icon: string; badge?: string }[] = [
        { id: 'overview', label: 'Fleet Telemetry', icon: '📊' },
        { id: 'analytics', label: 'Peak Analytics', icon: '📈' },
        { id: 'topology', label: 'Replication & Backups', icon: '🗄️' },
    ];

    const nodeScopedItems: { id: TabId; label: string; icon: string; badge?: string }[] = [
        { id: 'gateway', label: 'Gateway Security', icon: '🛡️' },
        { id: 'members', label: 'Trust & Members', icon: '👥' },
        { id: 'invites', label: 'Invites & Codes', icon: '🎫' },
        { id: 'onboarding', label: 'Onboarding Funnel', icon: '🚪' },
        { id: 'logs', label: 'System Streamer', icon: '📜' },
        { id: 'ai', label: 'Sovereign AI Copilot', icon: '🤖', badge: 'PRO' },
    ];

    const manual = useManual();
    const collapsible = !inDrawer && !isFleetMode && !!onCollapse;

    const renderNavItem = (item: { id: TabId; label: string; icon: string; badge?: string }) => {
        const isActive = activeTab === item.id;
        const counts = alertCountsFor(item.id, tabAlertCounts, isFleetMode);
        const hasCounts = counts.critical > 0 || counts.warning > 0;

        const subTabs = inDrawer && isActive && isSettingsSection(item.id) ? SECTION_SUB_TABS[item.id] : [];
        const button = (
            <button
                key={item.id}
                onClick={() => onSelectTab(item.id)}
                aria-current={isActive && (!inDrawer || subTabs.length === 0) ? 'page' : undefined}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl ${inDrawer ? 'min-h-[48px] text-sm' : 'text-xs'} font-semibold transition-all ${
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
                            title={`${counts.critical} Critical Alerts`}
                        >
                            <span>🚨</span>
                            <span>{counts.critical}</span>
                        </span>
                    )}
                    {counts.warning > 0 && (
                        <span
                            className="px-1.5 py-0.5 rounded-full bg-amber-500 text-black text-[9px] font-mono font-bold shadow-sm flex items-center gap-0.5"
                            title={`${counts.warning} Warnings`}
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
        if (subTabs.length === 0) return button;
        const current = activeSubTab || subTabs[0].id;
        return (
            <div key={item.id}>
                {button}
                <ul className="mt-1 mb-2 ml-5 pl-3 border-l border-nature-800 space-y-0.5" aria-label={`${item.label} screens`}>
                    {subTabs.map((sub) => (
                        <li key={sub.id}>
                            <button
                                type="button"
                                onClick={() => onSelectSubTab?.(item.id, sub.id)}
                                aria-current={current === sub.id ? 'page' : undefined}
                                className={`w-full text-left min-h-[48px] px-3 rounded-lg text-sm transition-all ${
                                    current === sub.id ? 'text-terra-300 font-bold bg-terra-500/10' : 'text-nature-300 hover:text-white hover:bg-nature-800/50'
                                }`}
                            >
                                {sub.label}
                            </button>
                        </li>
                    ))}
                </ul>
            </div>
        );
    };

    if (collapsible && mode === 'hidden') return null;
    if (collapsible && mode === 'icons') {
        return (
            <IconRail
                items={singleNodeNavItems}
                activeTab={activeTab}
                onSelectTab={onSelectTab}
                countsFor={(id) => alertCountsFor(id, tabAlertCounts, isFleetMode)}
                returnLinks={returnLinks}
                onOpenManual={manual ? () => manual.openManual() : undefined}
                onCollapse={onCollapse!}
            />
        );
    }

    return (
        <aside
            id={inDrawer ? 'settings-menu' : collapsible ? 'settings-sidebar' : undefined}
            className={inDrawer
                ? 'w-full min-h-full bg-nature-900 flex flex-col font-sans select-none'
                : `w-72 bg-nature-900 border-r border-nature-800 ${isFleetMode ? 'flex' : 'hidden lg:flex'} flex-col shrink-0 h-screen sticky top-0 font-sans z-30 select-none`}
        >
            {/* Header Brand */}
            <div className="p-5 border-b border-nature-800/80 flex items-center justify-between gap-2 lg:gap-0">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div
                        className="w-10 h-10 shrink-0 rounded-2xl bg-gradient-to-tr from-terra-600 to-terra-400 flex items-center justify-center text-xl shadow-lg shadow-terra-950/40 border border-terra-300/20"
                        aria-hidden="true"
                    >
                        🌱
                    </div>
                    <div className="min-w-0">
                        <h1 className="text-base font-extrabold tracking-tight text-white m-0 leading-tight truncate max-w-[170px]" title={isFleetMode ? 'BeanPool' : (communityName || 'BeanPool')}>
                            {isFleetMode ? 'BeanPool' : (communityName || 'BeanPool')}
                        </h1>
                        <p className="text-[11px] font-semibold text-terra-400 m-0">
                            {isFleetMode ? 'Fleet Manager v1.2' : 'Node Settings'}
                        </p>
                    </div>
                </div>
                {collapsible && (
                    <CollapseButton mode="full" onCollapse={onCollapse!} />
                )}
                {inDrawer && onClose && (
                    <button
                        type="button"
                        onClick={onClose}
                        data-autofocus
                        aria-label="Close menu"
                        className="shrink-0 min-w-[48px] min-h-[48px] -mr-2 rounded-xl text-xl text-nature-300 hover:text-white hover:bg-nature-800/60 flex items-center justify-center"
                    >
                        ✕
                    </button>
                )}
            </div>

            {!isFleetMode && returnLinks && <ReturnLinks links={returnLinks} large={inDrawer} />}

            {/* Navigation Tabs */}
            {isFleetMode ? (
                <div className="px-3 py-3 space-y-1 overflow-y-auto custom-scrollbar">
                    {/* Multi-Server Control Plane */}
                    <div className="px-3 pb-1 text-[10px] font-extrabold uppercase tracking-wider text-nature-400">
                        Multi-Server Control Plane
                    </div>
                    {multiServerItems.map(renderNavItem)}

                    {/* Divider Line */}
                    <div className="my-3 border-t border-nature-800/80 mx-2" />

                    {/* Selected Node Operations */}
                    <div className="px-3 pb-1 text-[10px] font-extrabold uppercase tracking-wider text-terra-400 flex items-center justify-between">
                        <span>Node Controls</span>
                        <span className="text-[9px] font-mono text-sky-400 truncate max-w-[110px]" title={activeNode?.name}>
                            {activeNode?.name || 'Selected'}
                        </span>
                    </div>
                    {nodeScopedItems.map(renderNavItem)}
                </div>
            ) : (
                <div className="px-3 py-3 space-y-1 overflow-y-auto custom-scrollbar">
                    <div className="px-3 pb-1 text-[10px] font-extrabold uppercase tracking-wider text-nature-400">
                        Navigation
                    </div>
                    {singleNodeNavItems.map(renderNavItem)}
                    {manual && (
                        <button
                            type="button"
                            onClick={() => {
                                onBeforeManual?.();
                                manual.openManual();
                            }}
                            className={`w-full flex items-center gap-2.5 px-3 py-2.5 min-h-[48px] rounded-xl ${inDrawer ? 'text-sm' : 'text-xs'} font-semibold text-nature-300 hover:text-white hover:bg-nature-800/50 border border-transparent transition-all`}
                        >
                            <span className="text-sm shrink-0">📖</span>
                            <span className="truncate">Manual: running your community</span>
                        </button>
                    )}
                </div>
            )}

            {/* Bottom Status / Fleet Panel */}
            {isFleetMode ? (
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
                        {profiles.length === 0 ? (
                        <div className="p-4 text-center rounded-xl bg-nature-950/40 border border-nature-800/80 space-y-2">
                            <div className="text-xl">🌱</div>
                            <div className="text-xs font-bold text-white">No Connected Nodes</div>
                            <p className="text-[11px] text-nature-400 m-0">
                                Add your first sovereign node profile to begin managing your fleet.
                            </p>
                            <button
                                onClick={onOpenAddModal}
                                className="px-3 py-1.5 rounded-lg bg-terra-500 hover:bg-terra-600 text-white font-bold text-xs shadow transition-all active:scale-95"
                            >
                                + Add Sovereign Node
                            </button>
                        </div>
                    ) : (
                        profiles.map((p, index) => {
                        const isSelected = p.id === activeProfileId;
                        const health = nodeHealthMap[p.id] || 'loading';
                        const isDragging = draggedIndex === index;
                        const isDragOver = dragOverIndex === index && draggedIndex !== index;

                        return (
                            <div
                                key={p.id}
                                draggable={true}
                                onDragStart={(e) => {
                                    setDraggedIndex(index);
                                    e.dataTransfer.effectAllowed = 'move';
                                    e.dataTransfer.setData('text/plain', index.toString());
                                }}
                                onDragOver={(e) => {
                                    e.preventDefault();
                                    e.dataTransfer.dropEffect = 'move';
                                    if (dragOverIndex !== index) {
                                        setDragOverIndex(index);
                                    }
                                }}
                                onDragLeave={() => {
                                    if (dragOverIndex === index) {
                                        setDragOverIndex(null);
                                    }
                                }}
                                onDrop={(e) => {
                                    e.preventDefault();
                                    if (draggedIndex !== null && draggedIndex !== index && onReorderNodes) {
                                        onReorderNodes(draggedIndex, index);
                                    }
                                    setDraggedIndex(null);
                                    setDragOverIndex(null);
                                }}
                                onDragEnd={() => {
                                    setDraggedIndex(null);
                                    setDragOverIndex(null);
                                }}
                                onClick={() => onSelectNode(p.id)}
                                className={`p-3 rounded-xl cursor-grab active:cursor-grabbing transition-all border relative group ${
                                    isDragging
                                        ? 'opacity-40 scale-[0.98] border-dashed border-terra-500 bg-terra-950/20'
                                        : isDragOver
                                        ? 'ring-2 ring-terra-400 border-terra-400 bg-terra-950/30 scale-[1.01] shadow-lg'
                                        : health === 'critical' || health === 'alert'
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
                                        <span
                                            className="text-nature-500 group-hover:text-nature-300 transition-colors shrink-0 cursor-grab active:cursor-grabbing text-xs select-none"
                                            title="Drag to rearrange node position"
                                        >
                                            ⠿
                                        </span>
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
                                                <span title="Unreachable" className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500"></span>
                                            ) : health === 'auth_required' ? (
                                                // Static amber: not red, because the node is up and answering — it is
                                                // this manager that has the wrong password. Not the pulsing amber of
                                                // `warning` either, since nothing is in progress; it waits on a person.
                                                <span title="Admin password needed" className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500"></span>
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
                    })
                    )}
                </div>
            </div>
            ) : (
                <div className="flex-1 flex flex-col justify-end min-h-0 border-t border-nature-800/80 px-4 py-4 space-y-3">
                    <div className="p-3.5 rounded-2xl bg-nature-950/60 border border-nature-800/80 space-y-2">
                        <div className="flex items-center justify-between">
                            <span className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400">Node Status</span>
                            <span className="flex items-center gap-1.5 text-[11px] text-emerald-400 font-bold">
                                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                                <span>Online</span>
                            </span>
                        </div>
                        <div className="text-xs font-bold text-white truncate" title={communityName || activeNode?.name}>
                            {communityName || activeNode?.name || 'Local Sovereign Node'}
                        </div>
                        <div className="text-[10px] font-mono text-nature-400 truncate">
                            {activeNode?.url?.replace(/^https?:\/\//, '') || 'localhost'}
                        </div>
                    </div>

                    <div className="flex items-center justify-between text-xs px-1">
                        <a
                            href="/settings-legacy"
                            className={`${inDrawer ? 'min-h-[48px] inline-flex items-center text-sm' : 'text-[11px]'} text-nature-400 hover:text-terra-400 transition-colors underline`}
                        >
                            Legacy Settings
                        </a>
                        {onLogout && (
                            <button
                                onClick={onLogout}
                                className={`${inDrawer ? 'min-h-[48px] px-2 text-sm' : 'text-[11px]'} text-nature-400 hover:text-red-400 transition-colors font-medium`}
                            >
                                Log Out
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* Footer Status */}
            <div className="p-3 border-t border-nature-800/80 bg-nature-950/60 text-[11px] text-nature-400 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                    <span>{isFleetMode ? 'Decoupled API Client' : 'Sovereign Node v1.4.2'}</span>
                </div>
                <span className="font-mono text-[10px] text-nature-500">{isFleetMode ? 'Fleet API' : 'Single Node'}</span>
            </div>
        </aside>
    );
}

/** A section's alert counts; in single-node Settings a section also carries the old tabs folded into it. */
function alertCountsFor(id: TabId, tabAlertCounts: Partial<Record<TabId, AlertCounts>>, isFleetMode: boolean): AlertCounts {
    const zero = { critical: 0, warning: 0 };
    const own = tabAlertCounts[id] || zero;
    if (isFleetMode) return own;
    const folded: TabId[] = id === 'people' ? ['members'] : id === 'appliance' ? ['gateway', 'logs'] : [];
    return folded.reduce((acc, t) => {
        const c = tabAlertCounts[t] || zero;
        return { critical: acc.critical + c.critical, warning: acc.warning + c.warning };
    }, own);
}

type TooltipBind = (label: string) => {
    onMouseEnter: (e: React.SyntheticEvent<HTMLElement>) => void;
    onFocus: (e: React.SyntheticEvent<HTMLElement>) => void;
    onMouseLeave: () => void;
    onBlur: () => void;
};

/** The desktop sidebar's collapse button: full → icon strip → hidden. */
function CollapseButton({ mode, onCollapse, tip }: {
    mode: 'full' | 'icons';
    onCollapse: () => void;
    tip?: TooltipBind;
}) {
    const label = mode === 'full' ? 'Collapse menu to icons' : 'Hide menu';
    return (
        <button
            type="button"
            onClick={onCollapse}
            aria-label={label}
            aria-expanded={mode === 'full'}
            aria-controls="settings-sidebar"
            title={tip ? undefined : label}
            {...tip?.(label)}
            className="hidden lg:flex shrink-0 w-10 h-10 rounded-xl items-center justify-center text-lg text-nature-300 hover:text-white hover:bg-nature-800/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-terra-400"
        >
            <span aria-hidden="true">«</span>
        </button>
    );
}

/**
 * The icon strip's names, on hover and on keyboard focus. Positioned `fixed` beside the icon, so the strip's
 * own scrolling cannot clip it; Escape dismisses it. Each icon keeps its name as its accessible name, so a
 * screen reader never depends on the tooltip.
 */
function useRailTooltip(): { tip: { label: string; top: number; left: number } | null; bind: TooltipBind; hide: () => void } {
    const [tip, setTip] = useState<{ label: string; top: number; left: number } | null>(null);
    const hide = () => setTip(null);
    const show = (label: string) => (e: React.SyntheticEvent<HTMLElement>) => {
        const r = e.currentTarget.getBoundingClientRect();
        setTip({ label, top: r.top + r.height / 2, left: r.right + 8 });
    };
    return { tip, hide, bind: (label) => ({ onMouseEnter: show(label), onFocus: show(label), onMouseLeave: hide, onBlur: hide }) };
}

function IconRail({ items, activeTab, onSelectTab, countsFor, returnLinks, onOpenManual, onCollapse }: {
    items: typeof singleNodeNavItems;
    activeTab: TabId;
    onSelectTab: (tab: TabId) => void;
    countsFor: (id: TabId) => AlertCounts;
    returnLinks?: ReturnLinksValue;
    onOpenManual?: () => void;
    onCollapse: () => void;
}) {
    const { tip, bind, hide } = useRailTooltip();
    const cell = 'relative w-12 h-12 rounded-xl flex items-center justify-center text-lg no-underline transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-terra-400';
    return (
        <aside
            id="settings-sidebar"
            aria-label="Settings menu"
            onKeyDown={(e) => { if (e.key === 'Escape') hide(); }}
            className="hidden lg:flex w-[72px] bg-nature-900 border-r border-nature-800 flex-col items-center shrink-0 h-screen sticky top-0 font-sans z-30 select-none"
        >
            <div className="py-4 flex flex-col items-center gap-2 border-b border-nature-800/80 w-full">
                <div
                    className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-terra-600 to-terra-400 flex items-center justify-center text-xl shadow-lg shadow-terra-950/40 border border-terra-300/20"
                    aria-hidden="true"
                >
                    🌱
                </div>
                <CollapseButton mode="icons" onCollapse={() => { hide(); onCollapse(); }} tip={bind} />
            </div>
            <div className="flex-1 w-full overflow-y-auto overflow-x-hidden custom-scrollbar py-3 flex flex-col items-center gap-1">
                {returnLinks && (
                    <nav aria-label="Leave Settings" className="flex flex-col items-center gap-1 pb-2 mb-1 border-b border-nature-800/80">
                        <a href={returnLinks.back.href} aria-label={returnLinks.back.label} {...bind(returnLinks.back.label)} className={`${cell} text-terra-200 bg-terra-500/10 border border-terra-500/30 hover:bg-terra-500/20`}>
                            <span aria-hidden="true">{returnLinks.back.glyph}</span>
                        </a>
                        {returnLinks.profile && (
                            <a href={returnLinks.profile.href} aria-label={returnLinks.profile.label} {...bind(returnLinks.profile.label)} className={`${cell} text-nature-200 hover:bg-nature-800/50`}>
                                <span aria-hidden="true">{returnLinks.profile.glyph}</span>
                            </a>
                        )}
                    </nav>
                )}
                {items.map((item) => {
                    const isActive = activeTab === item.id;
                    const counts = countsFor(item.id);
                    const alerts = counts.critical + counts.warning;
                    const name = alerts > 0 ? `${item.label} (${alerts} ${alerts === 1 ? 'alert' : 'alerts'})` : item.label;
                    return (
                        <button
                            key={item.id}
                            type="button"
                            onClick={() => onSelectTab(item.id)}
                            aria-label={name}
                            aria-current={isActive ? 'page' : undefined}
                            {...bind(name)}
                            className={`${cell} ${isActive ? 'bg-terra-500/15 border border-terra-500/40' : 'border border-transparent hover:bg-nature-800/50'}`}
                        >
                            <span aria-hidden="true">{item.icon}</span>
                            {alerts > 0 && (
                                <span aria-hidden="true" className={`absolute top-1.5 right-1.5 w-2.5 h-2.5 rounded-full ${counts.critical > 0 ? 'bg-red-500' : 'bg-amber-500'}`} />
                            )}
                        </button>
                    );
                })}
                {onOpenManual && (
                    <button
                        type="button"
                        onClick={() => { hide(); onOpenManual(); }}
                        aria-label="Manual: running your community"
                        {...bind('Manual: running your community')}
                        className={`${cell} border border-transparent hover:bg-nature-800/50`}
                    >
                        <span aria-hidden="true">📖</span>
                    </button>
                )}
            </div>
            {tip && (
                <div
                    role="tooltip"
                    style={{ position: 'fixed', top: tip.top, left: tip.left, transform: 'translateY(-50%)' }}
                    className="z-50 px-2.5 py-1.5 rounded-lg bg-nature-800 border border-nature-700 text-xs font-semibold text-white shadow-xl whitespace-nowrap pointer-events-none"
                >
                    {tip.label}
                </div>
            )}
        </aside>
    );
}
