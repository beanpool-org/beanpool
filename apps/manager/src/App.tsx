import React, { useState, useEffect } from 'react';
import {
    loadNodeProfiles,
    addNodeProfile,
    removeNodeProfile,
    loadActiveProfileId,
    saveActiveProfileId,
    updateNodeProfile,
    type NodeProfile,
} from './lib/profiles';
import {
    fetchDiagnostics,
    fetchGatewayConfig,
    updateGatewayConfig,
    fetchNodeData,
    fetchNodeLogs,
    freezeNodeUser,
    updateNodeUserTier,
    type DiagnosticsResponse,
    type GatewayConfig,
} from './lib/node-client';

import { FleetSidebar, type TabId, type NodeHealthStatus, type AlertCounts } from './components/layout/FleetSidebar';
import { AddNodeModal } from './components/nodes/AddNodeModal';
import { EditNodeModal } from './components/nodes/EditNodeModal';

import { TelemetryModule, type NodeDiagnosticState } from './components/modules/TelemetryModule';
import { GatewayModule } from './components/modules/GatewayModule';
import { MembersModule } from './components/modules/MembersModule';
import { TopologyModule } from './components/modules/TopologyModule';
import { InvitesModule } from './components/modules/InvitesModule';
import { LogsModule } from './components/modules/LogsModule';
import { AiServicesModule } from './components/modules/AiServicesModule';

export function App() {
    const [profiles, setProfiles] = useState<NodeProfile[]>(() => loadNodeProfiles());
    const [activeProfileId, setActiveProfileId] = useState<string>(() => loadActiveProfileId());
    const [activeTab, setActiveTab] = useState<TabId>(() => {
        try {
            return (localStorage.getItem('bp_fleet_active_tab') as TabId) || 'overview';
        } catch {
            return 'overview';
        }
    });

    const activeNode = profiles.find((p) => p.id === activeProfileId) || profiles[0];

    const [diag, setDiag] = useState<DiagnosticsResponse | null>(null);
    const [diagLoading, setDiagLoading] = useState(false);
    const [diagError, setDiagError] = useState<string | null>(null);

    const [fleetDiags, setFleetDiags] = useState<Record<string, NodeDiagnosticState>>({});
    const [fleetNodeData, setFleetNodeData] = useState<Record<string, any>>({});
    const [fleetGateways, setFleetGateways] = useState<Record<string, GatewayConfig>>({});

    const [gateway, setGateway] = useState<GatewayConfig | null>(null);
    const [gatewayLoading, setGatewayLoading] = useState(false);
    const [gatewaySuccess, setGatewaySuccess] = useState<string | null>(null);

    const [nodeData, setNodeData] = useState<any | null>(null);
    const [nodeDataLoading, setNodeDataLoading] = useState(false);
    const [nodeLogs, setNodeLogs] = useState<any[]>([]);

    const [showAddModal, setShowAddModal] = useState(false);
    const [editingNode, setEditingNode] = useState<NodeProfile | null>(null);

    const [nodeHealthMap, setNodeHealthMap] = useState<Record<string, NodeHealthStatus>>({});

    useEffect(() => {
        if (activeProfileId) {
            saveActiveProfileId(activeProfileId);
        }
    }, [activeProfileId]);

    useEffect(() => {
        try {
            localStorage.setItem('bp_fleet_active_tab', activeTab);
        } catch {}
    }, [activeTab]);

    // Load fleet-wide diagnostics and health flags for all connected nodes
    const refreshFleetDiagnostics = async () => {
        profiles.forEach(async (p) => {
            setFleetDiags((prev) => ({
                ...prev,
                [p.id]: { ...(prev[p.id] || { diag: null }), loading: true, error: null },
            }));
            try {
                const data = await fetchDiagnostics(p.url, p.adminPassword);
                setFleetDiags((prev) => ({
                    ...prev,
                    [p.id]: { diag: data, loading: false, error: null },
                }));

                // Fetch node gateway config for security alerts
                try {
                    const gData = await fetchGatewayConfig(p.url, p.adminPassword);
                    setFleetGateways((prev) => ({ ...prev, [p.id]: gData }));
                    if (p.id === activeNode?.id && gData) {
                        setGateway(gData);
                    }
                } catch {}

                // Fetch node data to check for active abuse/security flags
                try {
                    const nData = await fetchNodeData(p.url, p.adminPassword);
                    setFleetNodeData((prev) => ({ ...prev, [p.id]: nData }));

                    let savedDismissed = new Set<string>();
                    try {
                        const saved = localStorage.getItem('bp_dismissed_flags');
                        if (saved) savedDismissed = new Set(JSON.parse(saved));
                    } catch {}

                    const flags = (nData?.health?.flags || []).filter(
                        (f: any) => !savedDismissed.has(f.id || f.type || f.description)
                    );
                    const reports = (nData?.reports || []).filter(
                        (r: any) => !savedDismissed.has(r.id || r.targetPubkey || r.reason)
                    );

                    const hasAlert = flags.some((f: any) => f.severity === 'critical' || f.severity === 'alert') || reports.length > 0;
                    const hasWarning = flags.some((f: any) => f.severity === 'warning');

                    const status: NodeHealthStatus = hasAlert ? 'alert' : hasWarning ? 'warning' : 'online';
                    setNodeHealthMap((prev) => ({ ...prev, [p.id]: status }));
                } catch {
                    // Do not flip status to offline on rate limits
                }

                if (p.id === activeNode?.id) {
                    setDiag(data);
                    setDiagError(null);
                }
            } catch (e: any) {
                const errMsg = e.message || 'Failed to connect';
                if (!errMsg.includes('429')) {
                    setFleetDiags((prev) => ({
                        ...prev,
                        [p.id]: { diag: null, loading: false, error: errMsg },
                    }));
                    setNodeHealthMap((prev) => ({ ...prev, [p.id]: 'offline' }));
                    if (p.id === activeNode?.id) {
                        setDiagError(errMsg);
                    }
                }
            }
        });
    };

    // Load active node telemetry
    const loadDiagnostics = async () => {
        if (!activeNode) return;
        setDiagLoading(true);
        setDiagError(null);
        try {
            const data = await fetchDiagnostics(activeNode.url, activeNode.adminPassword);
            setDiag(data);
            setFleetDiags((prev) => ({
                ...prev,
                [activeNode.id]: { diag: data, loading: false, error: null },
            }));
        } catch (e: any) {
            const errMsg = e.message || 'Failed to connect to node';
            if (!errMsg.includes('429')) {
                setDiagError(errMsg);
            }
        } finally {
            setDiagLoading(false);
        }
    };

    // Load gateway config
    const loadGateway = async () => {
        if (!activeNode) return;
        setGatewayLoading(true);
        try {
            const data = await fetchGatewayConfig(activeNode.url, activeNode.adminPassword);
            setGateway(data);
        } catch (e: any) {
            const errMsg = e.message || '';
            // Only set gateway to null on explicit auth error, NOT on 429 rate limiting
            if (errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('Unauthorized')) {
                setGateway(null);
            }
        } finally {
            setGatewayLoading(false);
        }
    };

    // Load member data
    const loadNodeData = async () => {
        if (!activeNode) return;
        setNodeDataLoading(true);
        try {
            const data = await fetchNodeData(activeNode.url, activeNode.adminPassword);
            setNodeData(data);
            setFleetNodeData((prev) => ({ ...prev, [activeNode.id]: data }));

            const flags = data?.health?.flags || [];
            const reports = data?.reports || [];
            const hasAlert = flags.some((f: any) => f.severity === 'critical' || f.severity === 'alert') || reports.length > 0;
            const hasWarning = flags.some((f: any) => f.severity === 'warning');

            const status: NodeHealthStatus = hasAlert ? 'alert' : hasWarning ? 'warning' : 'online';
            setNodeHealthMap((prev) => ({ ...prev, [activeNode.id]: status }));
        } catch (e: any) {
            const errMsg = e.message || '';
            if (errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('Unauthorized')) {
                setNodeData(null);
            }
        } finally {
            setNodeDataLoading(false);
        }
    };

    // Load logs
    const loadLogs = async () => {
        if (!activeNode) return;
        try {
            const logs = await fetchNodeLogs(activeNode.url, activeNode.adminPassword);
            setNodeLogs(logs);
        } catch (e: any) {
            // Keep existing logs on error
        }
    };

    const refreshAll = () => {
        refreshFleetDiagnostics();
        loadGateway();
        loadNodeData();
        loadLogs();
    };

    useEffect(() => {
        refreshFleetDiagnostics();
    }, [profiles]);

    useEffect(() => {
        setDiag(null);
        setGateway(null);
        setNodeData(null);
        setNodeLogs([]);
        refreshAll();
    }, [activeProfileId]);

    const handleSaveGateway = async () => {
        if (!activeNode || !gateway) return;
        setGatewaySuccess(null);
        try {
            const updated = await updateGatewayConfig(activeNode.url, gateway, activeNode.adminPassword);
            setGateway(updated);
            setFleetGateways((prev) => ({ ...prev, [activeNode.id]: updated }));
            setGatewaySuccess('✅ Gateway configuration updated successfully!');
            setTimeout(() => setGatewaySuccess(null), 3000);
        } catch (e: any) {
            alert('Failed to update gateway: ' + e.message);
        }
    };

    const handleAddNode = (name: string, url: string, adminPassword?: string) => {
        const created = addNodeProfile({ name, url, adminPassword });
        const updated = loadNodeProfiles();
        setProfiles(updated);
        setActiveProfileId(created.id);
        setShowAddModal(false);
    };

    const handleSaveNodeEdit = (id: string, updates: Partial<NodeProfile>) => {
        const updatedProfiles = updateNodeProfile(id, updates);
        setProfiles(updatedProfiles);
        setEditingNode(null);
        refreshAll();
    };

    const handleRemoveNode = (id: string) => {
        if (profiles.length <= 1) {
            alert('Cannot delete the last node profile.');
            return;
        }
        if (confirm('Are you sure you want to remove this node profile from Fleet Manager?')) {
            removeNodeProfile(id);
            const remaining = loadNodeProfiles();
            setProfiles(remaining);
            setActiveProfileId(remaining[0].id);
        }
    };

    // Aggregate alert and warning counts across all connected nodes in the fleet
    const offlineNodesCount = profiles.filter((p) => nodeHealthMap[p.id] === 'offline').length;
    const telemetryWalWarnings = profiles.filter((p) => {
        const wal = fleetDiags[p.id]?.diag?.walSizeBytes || 0;
        return wal > 10 * 1024 * 1024; // >10MB SQLite WAL file
    }).length;

    let globalDismissed = new Set<string>();
    try {
        const saved = localStorage.getItem('bp_dismissed_flags');
        if (saved) globalDismissed = new Set(JSON.parse(saved));
    } catch {}

    const totalMemberCritical = Object.values(fleetNodeData).reduce((acc, nData: any) => {
        if (!nData) return acc;
        const flags = (nData.health?.flags || []).filter((f: any) => !globalDismissed.has(f.id || f.type || f.description));
        const reports = (nData.reports || []).filter((r: any) => !globalDismissed.has(r.id || r.targetPubkey || r.reason));
        const crit = flags.filter((f: any) => f.severity === 'critical' || f.severity === 'alert').length;
        return acc + crit + reports.length;
    }, 0);

    const totalMemberWarning = Object.values(fleetNodeData).reduce((acc, nData: any) => {
        if (!nData) return acc;
        const flags = (nData.health?.flags || []).filter((f: any) => !globalDismissed.has(f.id || f.type || f.description));
        const warn = flags.filter((f: any) => f.severity === 'warning').length;
        return acc + warn;
    }, 0);

    const logErrorsCount = nodeLogs.filter((l: any) => (l.level || '').toUpperCase() === 'ERROR').length;
    const logWarningsCount = nodeLogs.filter((l: any) => (l.level || '').toUpperCase() === 'WARN' || (l.level || '').toUpperCase() === 'WARNING').length;

    const loadedGateways = Object.keys(fleetGateways).length > 0 ? Object.values(fleetGateways) : (gateway ? [gateway] : []);

    const totalGatewayCritical = loadedGateways.reduce((acc, gData: any) => {
        if (!gData) return acc;
        const rateLimitOff = gData.rateLimiting?.enabled === false ? 1 : 0;
        return acc + rateLimitOff;
    }, 0);

    const totalGatewayWarning = loadedGateways.reduce((acc, gData: any) => {
        if (!gData) return acc;
        const wildcardCors = (gData.corsAllowedOrigins || []).includes('*') ? 1 : 0;
        const disabledFeatures = Object.values(gData.features || {}).filter((v) => v === false).length;
        return acc + wildcardCors + disabledFeatures;
    }, 0);

    const tabAlertCounts: Partial<Record<TabId, AlertCounts>> = {
        overview: { critical: offlineNodesCount, warning: telemetryWalWarnings },
        gateway: { critical: totalGatewayCritical, warning: totalGatewayWarning },
        members: { critical: totalMemberCritical, warning: totalMemberWarning },
        topology: { critical: 0, warning: 0 },
        invites: { critical: 0, warning: 0 },
        logs: { critical: logErrorsCount, warning: logWarningsCount },
        ai: { critical: 0, warning: 0 },
    };

    return (
        <div className="min-h-screen bg-nature-950 text-nature-100 flex font-sans antialiased">
            {/* Left Vertical Navigation & Connected Fleet Sidebar */}
            <FleetSidebar
                profiles={profiles}
                activeProfileId={activeProfileId}
                onSelectNode={(id) => setActiveProfileId(id)}
                onOpenAddModal={() => setShowAddModal(true)}
                onEditNode={(node) => setEditingNode(node)}
                onRemoveNode={handleRemoveNode}
                activeTab={activeTab}
                onSelectTab={(tab) => setActiveTab(tab)}
                nodeHealthMap={nodeHealthMap}
                tabAlertCounts={tabAlertCounts}
            />

            {/* Main Content Area */}
            <div className="flex-1 flex flex-col min-w-0 min-h-screen">
                {/* Active Target Banner for Control Subsystems */}
                {activeTab !== 'overview' && (
                    <div className="bg-nature-900/60 border-b border-nature-800 px-6 py-2.5 flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2 font-mono">
                            <span className="text-nature-400">Target Control Node:</span>
                            <span className="text-white font-bold">{activeNode?.name}</span>
                            <span className="text-nature-600">|</span>
                            <code className="text-terra-400">{activeNode?.url}</code>
                        </div>
                        <button
                            onClick={() => setEditingNode(activeNode)}
                            className="px-2.5 py-1 rounded-lg bg-nature-800 hover:bg-nature-700 text-nature-200 font-bold transition-all border border-nature-700 flex items-center gap-1.5 active:scale-95"
                        >
                            <span>⚙️ Configure Credentials</span>
                        </button>
                    </div>
                )}

                {/* Workspace Body */}
                <main className="flex-1 p-6 md:p-8 max-w-7xl w-full mx-auto space-y-6">
                    {activeTab === 'overview' && (
                        <TelemetryModule
                            profiles={profiles}
                            activeProfileId={activeProfileId}
                            fleetDiags={fleetDiags}
                            onSelectNode={(id) => setActiveProfileId(id)}
                            onInspectNodeThreats={(id) => {
                                setActiveProfileId(id);
                                setActiveTab('members');
                            }}
                            onEditNode={(node) => setEditingNode(node)}
                            onRefreshFleet={refreshFleetDiagnostics}
                        />
                    )}

                    {activeTab === 'gateway' && (
                        <GatewayModule
                            gateway={gateway}
                            gatewayLoading={gatewayLoading}
                            gatewaySuccess={gatewaySuccess}
                            onChangeGateway={(updated) => setGateway(updated)}
                            onSaveGateway={handleSaveGateway}
                            onAuthenticate={(pwd) => {
                                if (activeNode) {
                                    handleSaveNodeEdit(activeNode.id, { adminPassword: pwd });
                                }
                            }}
                        />
                    )}

                    {activeTab === 'members' && (
                        <MembersModule
                            nodeData={nodeData}
                            nodeDataLoading={nodeDataLoading}
                            onRefresh={() => loadNodeData()}
                            onFreezeUser={async (pubkey, freeze) => {
                                if (activeNode) {
                                    await freezeNodeUser(activeNode.url, pubkey, freeze, activeNode.adminPassword);
                                }
                            }}
                            onUpdateTier={async (pubkey, tier) => {
                                if (activeNode) {
                                    await updateNodeUserTier(activeNode.url, pubkey, tier, activeNode.adminPassword);
                                }
                            }}
                        />
                    )}

                    {activeTab === 'topology' && (
                        <TopologyModule
                            activeNode={activeNode}
                            diag={diag}
                            onRefresh={() => loadDiagnostics()}
                        />
                    )}

                    {activeTab === 'invites' && <InvitesModule activeNode={activeNode} />}

                    {activeTab === 'logs' && (
                        <LogsModule logs={nodeLogs} onRefresh={() => loadLogs()} />
                    )}

                    {activeTab === 'ai' && (
                        <AiServicesModule
                            activeNode={activeNode}
                            contextData={{ telemetry: diag, gateway, members: nodeData?.members, logs: nodeLogs }}
                        />
                    )}
                </main>
            </div>

            {/* Add Node Modal */}
            {showAddModal && (
                <AddNodeModal onClose={() => setShowAddModal(false)} onAdd={handleAddNode} />
            )}

            {/* Edit / Configure Node Modal */}
            {editingNode && (
                <EditNodeModal
                    node={editingNode}
                    onClose={() => setEditingNode(null)}
                    onSave={handleSaveNodeEdit}
                />
            )}
        </div>
    );
}
