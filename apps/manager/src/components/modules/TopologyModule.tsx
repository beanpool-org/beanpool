import React, { useState, useEffect } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import type { DiagnosticsResponse } from '../../lib/node-client';
import {
    fetchHarvesterStatus,
    triggerHarvesterSync,
    fetchNodeHistory,
    fetchNodeSnapshots,
    createNodeSnapshot,
    deleteNodeSnapshot,
    updateNodeReplicationCadence,
    forceNodeResync,
    getRegistrarPending,
    approveRegistrarClaim,
    revokeRegistrarClaim,
    type HarvesterNodeState,
    type HistoryFileItem,
    type SnapshotItem,
    type RegistrarAllocation,
} from '../../lib/node-client';

interface TopologyModuleProps {
    activeNode: NodeProfile;
    diag: DiagnosticsResponse | null;
    profiles?: NodeProfile[];
    onRefresh: () => void;
}

type TabType = 'fleet-backups' | 'snapshots' | 'replication' | 'runbook' | 'name-claims';

export function TopologyModule({ activeNode, diag, profiles = [], onRefresh }: TopologyModuleProps) {
    const [activeTab, setActiveTab] = useState<TabType>('fleet-backups');

    // Harvester State
    const [harvesterState, setHarvesterState] = useState<Record<string, HarvesterNodeState>>({});
    const [harvestLoading, setHarvestLoading] = useState(false);
    const [harvestingNodeId, setHarvestingNodeId] = useState<string | null>(null);

    // History Modal State
    const [selectedHistoryNode, setSelectedHistoryNode] = useState<{ id: string; name: string } | null>(null);
    const [historyList, setHistoryList] = useState<HistoryFileItem[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);

    // On-Node Snapshots State
    const [snapshotNodeId, setSnapshotNodeId] = useState<string>(activeNode?.id || 'local-node');
    const [snapshots, setSnapshots] = useState<SnapshotItem[]>([]);
    const [snapshotLoading, setSnapshotLoading] = useState(false);
    const [creatingSnapshot, setCreatingSnapshot] = useState(false);

    // Replication Cadence State
    const [pullSeconds, setPullSeconds] = useState<number>(60);
    const [reconcileMinutes, setReconcileMinutes] = useState<number>(15);
    const [cadenceSaving, setCadenceSaving] = useState(false);
    const [cadenceMsg, setCadenceMsg] = useState<string | null>(null);
    const [resyncing, setResyncing] = useState(false);

    // DNS Registrar Claims State
    const [registrarAllocations, setRegistrarAllocations] = useState<RegistrarAllocation[]>([]);
    const [registrarLoading, setRegistrarLoading] = useState(false);
    const [registrarError, setRegistrarError] = useState<string | null>(null);
    const [actionToast, setActionToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
    const [confirmAction, setConfirmAction] = useState<{ name: string; type: 'approve' | 'reject' | 'revoke' } | null>(null);
    const [autoRefreshRegistrar, setAutoRefreshRegistrar] = useState(true);

    const targetSnapshotNode = profiles.find(p => p.id === snapshotNodeId) || activeNode;

    const loadRegistrar = async () => {
        setRegistrarLoading(true);
        setRegistrarError(null);
        try {
            const items = await getRegistrarPending(activeNode?.url, activeNode?.adminPassword);
            setRegistrarAllocations(items);
        } catch (e: any) {
            setRegistrarError(e.message || 'Failed to load registrar claims');
        } finally {
            setRegistrarLoading(false);
        }
    };

    useEffect(() => {
        if (activeTab === 'name-claims') {
            loadRegistrar();
        }
    }, [activeTab, activeNode?.url, activeNode?.adminPassword]);

    useEffect(() => {
        if (activeTab === 'name-claims' && autoRefreshRegistrar) {
            const timer = setInterval(loadRegistrar, 10000);
            return () => clearInterval(timer);
        }
    }, [activeTab, autoRefreshRegistrar, activeNode?.url, activeNode?.adminPassword]);

    const handleApproveClaim = async (name: string) => {
        try {
            await approveRegistrarClaim(activeNode?.url, name, activeNode?.adminPassword);
            setActionToast({ type: 'success', message: `✅ Approved claim for domain ${name}.beanpool.org` });
            setConfirmAction(null);
            await loadRegistrar();
        } catch (e: any) {
            setActionToast({ type: 'error', message: `❌ Failed to approve domain ${name}: ${e.message}` });
        }
    };

    const handleRejectClaim = async (name: string) => {
        try {
            await revokeRegistrarClaim(activeNode?.url, name, activeNode?.adminPassword);
            setActionToast({ type: 'success', message: `🚫 Rejected claim for domain ${name}.beanpool.org` });
            setConfirmAction(null);
            await loadRegistrar();
        } catch (e: any) {
            setActionToast({ type: 'error', message: `❌ Failed to reject domain ${name}: ${e.message}` });
        }
    };

    const handleRevokeAllocation = async (name: string) => {
        try {
            await revokeRegistrarClaim(activeNode?.url, name, activeNode?.adminPassword);
            setActionToast({ type: 'success', message: `⚠️ Revoked active allocation for domain ${name}.beanpool.org` });
            setConfirmAction(null);
            await loadRegistrar();
        } catch (e: any) {
            setActionToast({ type: 'error', message: `❌ Failed to revoke domain ${name}: ${e.message}` });
        }
    };

    // Load Harvester status
    const loadHarvester = async () => {
        setHarvestLoading(true);
        try {
            const data = await fetchHarvesterStatus();
            setHarvesterState(data.harvestState || {});
        } catch (e) {
            console.warn('[HarvesterUI] Failed to fetch harvester status:', e);
        } finally {
            setHarvestLoading(false);
        }
    };

    useEffect(() => {
        loadHarvester();
        const interval = setInterval(loadHarvester, 15000);
        return () => clearInterval(interval);
    }, []);

    // Load Snapshots for target node
    const loadSnapshots = async () => {
        if (!targetSnapshotNode) return;
        setSnapshotLoading(true);
        try {
            const items = await fetchNodeSnapshots(targetSnapshotNode.url, targetSnapshotNode.adminPassword);
            setSnapshots(items);
        } catch {
            setSnapshots([]);
        } finally {
            setSnapshotLoading(false);
        }
    };

    useEffect(() => {
        if (activeTab === 'snapshots') {
            loadSnapshots();
        }
    }, [activeTab, snapshotNodeId]);

    // Manual Sync Trigger
    const handleTriggerSync = async (nodeId: string, node?: NodeProfile) => {
        setHarvestingNodeId(nodeId);
        try {
            await triggerHarvesterSync(nodeId, node?.url, node?.adminPassword);
            await loadHarvester();
        } catch (e: any) {
            alert(`Harvest sync failed: ${e.message}`);
        } finally {
            setHarvestingNodeId(null);
        }
    };

    // Open History Modal
    const handleOpenHistory = async (nodeId: string, name: string) => {
        setSelectedHistoryNode({ id: nodeId, name });
        setHistoryLoading(true);
        try {
            const items = await fetchNodeHistory(nodeId);
            setHistoryList(items);
        } catch {
            setHistoryList([]);
        } finally {
            setHistoryLoading(false);
        }
    };

    // Create Snapshot Now
    const handleCreateSnapshot = async () => {
        if (!targetSnapshotNode) return;
        setCreatingSnapshot(true);
        try {
            await createNodeSnapshot(targetSnapshotNode.url, targetSnapshotNode.adminPassword);
            await loadSnapshots();
        } catch (e: any) {
            alert(`Snapshot creation failed: ${e.message}`);
        } finally {
            setCreatingSnapshot(false);
        }
    };

    // Delete Snapshot
    const handleDeleteSnapshot = async (name: string) => {
        if (!targetSnapshotNode || !confirm(`Delete snapshot ${name}?`)) return;
        try {
            await deleteNodeSnapshot(targetSnapshotNode.url, name, targetSnapshotNode.adminPassword);
            await loadSnapshots();
        } catch (e: any) {
            alert(`Failed to delete snapshot: ${e.message}`);
        }
    };

    // Save Replication Cadence
    const handleSaveCadence = async () => {
        if (!activeNode) return;
        setCadenceSaving(true);
        setCadenceMsg(null);
        try {
            await updateNodeReplicationCadence(activeNode.url, pullSeconds, reconcileMinutes, activeNode.adminPassword);
            setCadenceMsg('✅ Replication cadence updated!');
        } catch (e: any) {
            setCadenceMsg(`❌ Error: ${e.message}`);
        } finally {
            setCadenceSaving(false);
        }
    };

    // Force Resync
    const handleForceResync = async () => {
        if (!activeNode || !confirm(`Force full resync for ${activeNode.name}? This discards drifted rows on standby.`)) return;
        setResyncing(true);
        try {
            await forceNodeResync(activeNode.url, activeNode.adminPassword);
            alert('Replication resync requested.');
        } catch (e: any) {
            alert(`Resync failed: ${e.message}`);
        } finally {
            setResyncing(false);
        }
    };

    const fmtBytes = (bytes: number): string => {
        if (!bytes || bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    const relTime = (iso: string | null): string => {
        if (!iso) return 'Never';
        const ms = Date.now() - new Date(iso).getTime();
        if (ms < 60000) return 'Just now';
        const min = Math.floor(ms / 60000);
        if (min < 60) return `${min}m ago`;
        const hrs = Math.floor(min / 60);
        if (hrs < 24) return `${hrs}h ago`;
        return `${Math.floor(hrs / 24)}d ago`;
    };

    const fmtDate = (secOrIso: number | string | null | undefined): string => {
        if (!secOrIso) return 'Never';
        if (typeof secOrIso === 'string') return relTime(secOrIso);
        const ms = secOrIso < 1e11 ? secOrIso * 1000 : secOrIso;
        const date = new Date(ms);
        return `${date.toLocaleDateString()} ${date.toLocaleTimeString()} (${relTime(date.toISOString())})`;
    };

    const getSlug = (node: NodeProfile | string): string => {
        if (!node) return 'unknown';
        const id = typeof node === 'string' ? node : node.id;
        const url = typeof node === 'object' ? node.url || '' : '';
        const name = typeof node === 'object' ? node.name || '' : '';

        if (['test', 'mullum', 'bris', 'bindarrabi', 'eastgippy', 'gippsland', 'castlemaine', 'melb', 'review', 'local-node'].includes(id)) {
            return id;
        }

        const str = `${id} ${url} ${name}`.toLowerCase();
        if (str.includes('test')) return 'test';
        if (str.includes('mullum')) return 'mullum';
        if (str.includes('bris')) return 'bris';
        if (str.includes('bindarrabi')) return 'bindarrabi';
        if (str.includes('eastgippy') || str.includes('east-gippsland')) return 'eastgippy';
        if (str.includes('gippsland')) return 'gippsland';
        if (str.includes('castlemaine')) return 'castlemaine';
        if (str.includes('melb') || str.includes('melbourne')) return 'melb';
        if (str.includes('review')) return 'review';
        if (str.includes('localhost') || str.includes('127.0.0.1')) return 'local-node';

        return id;
    };

    const fleetNodesList = profiles.length > 0 ? profiles : [activeNode];
    const totalFleetBackupBytes = Object.values(harvesterState).reduce((acc, curr) => acc + (curr.dbSizeBytes || 0), 0);

    return (
        <div className="bg-nature-900/80 border border-nature-800 rounded-2xl p-6 space-y-6 shadow-xl font-sans animate-fade-in">
            {/* Module Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h3 className="text-lg font-bold text-white m-0 flex items-center gap-2">
                        <span>🗄️</span>
                        <span>Fleet Backup, Replication & Identity Hub</span>
                    </h3>
                    <p className="text-xs text-nature-400 m-0 mt-1">
                        Automated drift harvesting, 30-day snapshot archives, cryptographic identity collection, and disaster recovery.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => { loadHarvester(); onRefresh(); }}
                        disabled={harvestLoading}
                        className="px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all flex items-center gap-2 active:scale-95 disabled:opacity-50"
                    >
                        <span className={harvestLoading ? 'animate-spin' : ''}>🔄</span>
                        <span>Refresh</span>
                    </button>
                </div>
            </div>

            {/* Navigation Tabs */}
            <div className="flex items-center gap-2 border-b border-nature-800 pb-3 overflow-x-auto">
                <button
                    onClick={() => setActiveTab('fleet-backups')}
                    className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 whitespace-nowrap ${
                        activeTab === 'fleet-backups'
                            ? 'bg-terra-500 text-white shadow-lg shadow-terra-500/20'
                            : 'bg-nature-950/60 text-nature-400 hover:text-white border border-nature-800'
                    }`}
                >
                    <span>📦</span>
                    <span>Harvested Fleet Backups</span>
                </button>
                <button
                    onClick={() => setActiveTab('snapshots')}
                    className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 whitespace-nowrap ${
                        activeTab === 'snapshots'
                            ? 'bg-terra-500 text-white shadow-lg shadow-terra-500/20'
                            : 'bg-nature-950/60 text-nature-400 hover:text-white border border-nature-800'
                    }`}
                >
                    <span>📸</span>
                    <span>On-Node Snapshots</span>
                </button>
                <button
                    onClick={() => setActiveTab('replication')}
                    className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 whitespace-nowrap ${
                        activeTab === 'replication'
                            ? 'bg-terra-500 text-white shadow-lg shadow-terra-500/20'
                            : 'bg-nature-950/60 text-nature-400 hover:text-white border border-nature-800'
                    }`}
                >
                    <span>🔄</span>
                    <span>Replication & Standby</span>
                </button>
                <button
                    onClick={() => setActiveTab('name-claims')}
                    className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 whitespace-nowrap ${
                        activeTab === 'name-claims'
                            ? 'bg-terra-500 text-white shadow-lg shadow-terra-500/20'
                            : 'bg-nature-950/60 text-nature-400 hover:text-white border border-nature-800'
                    }`}
                >
                    <span>🌐</span>
                    <span>Domain Name Claims</span>
                </button>
                <button
                    onClick={() => setActiveTab('runbook')}
                    className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 whitespace-nowrap ${
                        activeTab === 'runbook'
                            ? 'bg-terra-500 text-white shadow-lg shadow-terra-500/20'
                            : 'bg-nature-950/60 text-nature-400 hover:text-white border border-nature-800'
                    }`}
                >
                    <span>🛠️</span>
                    <span>Disaster Recovery Runbook</span>
                </button>
            </div>

            {/* TAB 1: HARVESTED FLEET BACKUPS */}
            {activeTab === 'fleet-backups' && (
                <div className="space-y-6">
                    {/* Summary Banner */}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        <div className="bg-nature-950/60 border border-nature-800 p-4 rounded-xl">
                            <div className="text-[10px] font-bold text-nature-400 uppercase tracking-wider">Active Harvester</div>
                            <div className="text-lg font-black text-emerald-400 mt-1 flex items-center gap-2">
                                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
                                <span>60s Drift Poller</span>
                            </div>
                        </div>
                        <div className="bg-nature-950/60 border border-nature-800 p-4 rounded-xl">
                            <div className="text-[10px] font-bold text-nature-400 uppercase tracking-wider">Total Fleet Replicas</div>
                            <div className="text-lg font-black text-sky-400 mt-1">{fmtBytes(totalFleetBackupBytes)}</div>
                        </div>
                        <div className="bg-nature-950/60 border border-nature-800 p-4 rounded-xl flex items-center justify-between">
                            <div>
                                <div className="text-[10px] font-bold text-nature-400 uppercase tracking-wider">Fleet Coverage</div>
                                <div className="text-lg font-black text-amber-400 mt-1">{fleetNodesList.length} Nodes</div>
                            </div>
                            <button
                                onClick={() => handleTriggerSync('all')}
                                disabled={harvestingNodeId === 'all'}
                                className="px-3 py-1.5 rounded-lg bg-terra-500 hover:bg-terra-600 text-white font-bold text-xs shadow-md transition-all active:scale-95 disabled:opacity-50"
                            >
                                {harvestingNodeId === 'all' ? 'Syncing...' : 'Sync All Now'}
                            </button>
                        </div>
                    </div>

                    {/* Nodes Table */}
                    <div className="bg-nature-950/60 border border-nature-800 rounded-2xl overflow-hidden">
                        <div className="px-5 py-4 border-b border-nature-800 flex items-center justify-between">
                            <h4 className="text-xs font-extrabold text-terra-400 uppercase tracking-wider m-0">
                                Harvested Node Replicas & Identity Bundles
                            </h4>
                            <span className="text-xs text-nature-400 font-mono">Auto-prunes history archives &gt;30d</span>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-left text-xs">
                                <thead>
                                    <tr className="border-b border-nature-800 bg-nature-900/40 text-nature-400 text-[10px] uppercase font-bold tracking-wider">
                                        <th className="px-4 py-3">Node</th>
                                        <th className="px-4 py-3">Status</th>
                                        <th className="px-4 py-3">Replica Size</th>
                                        <th className="px-4 py-3">Counts</th>
                                        <th className="px-4 py-3">Identity</th>
                                        <th className="px-4 py-3">30-Day Archives</th>
                                        <th className="px-4 py-3">Last Harvest</th>
                                        <th className="px-4 py-3 text-right">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-nature-800/60">
                                    {fleetNodesList.map((node) => {
                                        const slug = getSlug(node);
                                        const state = harvesterState[node.id] || harvesterState[slug];
                                        const isSyncing = harvestingNodeId === node.id || harvestingNodeId === slug;

                                        return (
                                            <tr key={node.id} className="hover:bg-nature-900/30 transition-colors">
                                                <td className="px-4 py-3">
                                                    <div className="font-bold text-white">{node.name}</div>
                                                    <div className="text-[10px] text-sky-400 font-mono">{node.url}</div>
                                                </td>
                                                <td className="px-4 py-3">
                                                    {state?.status === 'ok' && (
                                                        <span className="px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800 font-mono font-bold text-[10px]">
                                                            OK
                                                        </span>
                                                    )}
                                                    {state?.status === 'harvesting' && (
                                                        <span className="px-2 py-0.5 rounded bg-sky-950 text-sky-400 border border-sky-800 font-mono font-bold text-[10px] animate-pulse">
                                                            PULLING
                                                        </span>
                                                    )}
                                                    {state?.status === 'error' && (
                                                        <span className="px-2 py-0.5 rounded bg-rose-950 text-rose-400 border border-rose-800 font-mono font-bold text-[10px]" title={state.error || ''}>
                                                            ERROR
                                                        </span>
                                                    )}
                                                    {(!state || state.status === 'idle') && (
                                                        <span className="px-2 py-0.5 rounded bg-nature-900 text-nature-400 border border-nature-700 font-mono font-bold text-[10px]">
                                                            IDLE
                                                        </span>
                                                    )}
                                                </td>
                                                <td className="px-4 py-3 font-mono font-bold text-amber-400">
                                                    {state?.dbSizeBytes ? fmtBytes(state.dbSizeBytes) : '—'}
                                                </td>
                                                <td className="px-4 py-3 text-nature-300">
                                                    {state ? (
                                                        <span>{state.memberCount} members · {state.postCount} posts</span>
                                                    ) : '—'}
                                                </td>
                                                <td className="px-4 py-3">
                                                    {state?.identityStatus === 'secured' && (
                                                        <span className="px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800 font-bold text-[10px]">
                                                            ✓ Secured ({state.identityFiles.length} files)
                                                        </span>
                                                    )}
                                                    {state?.identityStatus === 'partial' && (
                                                        <span className="px-2 py-0.5 rounded bg-amber-950 text-amber-400 border border-amber-800 font-bold text-[10px]">
                                                            Partial
                                                        </span>
                                                    )}
                                                    {(!state || state.identityStatus === 'missing') && (
                                                        <span className="px-2 py-0.5 rounded bg-nature-900 text-nature-400 border border-nature-700 font-bold text-[10px]">
                                                            Missing
                                                        </span>
                                                    )}
                                                </td>
                                                <td className="px-4 py-3 text-nature-300 font-mono font-bold">
                                                    {state?.historyCount || 0} days
                                                </td>
                                                <td className="px-4 py-3 text-nature-400 font-mono">
                                                    {relTime(state?.lastHarvestAt || null)}
                                                </td>
                                                <td className="px-4 py-3 text-right">
                                                    <div className="flex items-center justify-end gap-1.5">
                                                        <button
                                                            onClick={() => handleTriggerSync(slug, node)}
                                                            disabled={isSyncing}
                                                            className="px-2.5 py-1 rounded-lg bg-nature-800 hover:bg-nature-700 text-white font-bold text-[11px] transition-all"
                                                        >
                                                            {isSyncing ? '...' : '🔄 Sync'}
                                                        </button>
                                                        <a
                                                            href={`/api/manager/backups/download-db?nodeId=${slug}${node.adminPassword ? `&password=${encodeURIComponent(node.adminPassword)}` : ''}`}
                                                            target="_blank"
                                                            rel="noreferrer"
                                                            className="px-2.5 py-1 rounded-lg bg-nature-800 hover:bg-nature-700 text-sky-400 font-bold text-[11px] transition-all inline-block"
                                                        >
                                                            ⬇ DB
                                                        </a>
                                                        <button
                                                            onClick={() => handleOpenHistory(slug, node.name)}
                                                            className="px-2.5 py-1 rounded-lg bg-nature-800 hover:bg-nature-700 text-amber-400 font-bold text-[11px] transition-all"
                                                        >
                                                            📅 History
                                                        </button>
                                                        <a
                                                            href={`/api/manager/backups/download-identity?nodeId=${slug}${node.adminPassword ? `&password=${encodeURIComponent(node.adminPassword)}` : ''}`}
                                                            target="_blank"
                                                            rel="noreferrer"
                                                            className="px-2.5 py-1 rounded-lg bg-nature-800 hover:bg-nature-700 text-emerald-400 font-bold text-[11px] transition-all inline-block"
                                                        >
                                                            🔑 Identity
                                                        </a>
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}

            {/* TAB 2: ON-NODE SNAPSHOTS */}
            {activeTab === 'snapshots' && (
                <div className="space-y-6">
                    <div className="bg-nature-950/60 border border-nature-800 p-5 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div className="flex items-center gap-3">
                            <label className="text-xs font-bold text-nature-300">Target Node:</label>
                            <select
                                value={snapshotNodeId}
                                onChange={(e) => setSnapshotNodeId(e.target.value)}
                                className="bg-nature-900 border border-nature-700 rounded-xl px-3 py-1.5 text-xs text-white font-bold focus:outline-none focus:border-terra-500"
                            >
                                {fleetNodesList.map(n => (
                                    <option key={n.id} value={n.id}>{n.name} ({n.url})</option>
                                ))}
                            </select>
                        </div>
                        <button
                            onClick={handleCreateSnapshot}
                            disabled={creatingSnapshot}
                            className="px-4 py-2 rounded-xl bg-terra-500 hover:bg-terra-600 text-white font-bold text-xs shadow-lg transition-all active:scale-95 disabled:opacity-50 flex items-center gap-2"
                        >
                            <span>{creatingSnapshot ? '⏳' : '📸'}</span>
                            <span>Create Snapshot Now</span>
                        </button>
                    </div>

                    <div className="bg-nature-950/60 border border-nature-800 rounded-2xl overflow-hidden">
                        <div className="px-5 py-4 border-b border-nature-800 flex items-center justify-between">
                            <h4 className="text-xs font-extrabold text-terra-400 uppercase tracking-wider m-0">
                                On-Device SQLite Snapshots ({targetSnapshotNode?.name})
                            </h4>
                            {snapshotLoading && <span className="text-xs text-sky-400 animate-pulse">Loading snapshots…</span>}
                        </div>
                        {snapshots.length === 0 ? (
                            <div className="p-8 text-center text-xs text-nature-400">
                                No on-device snapshots found for this node yet. Click &quot;Create Snapshot Now&quot; above to take a point-in-time snapshot.
                            </div>
                        ) : (
                            <table className="w-full text-left text-xs">
                                <thead>
                                    <tr className="border-b border-nature-800 bg-nature-900/40 text-nature-400 text-[10px] uppercase font-bold tracking-wider">
                                        <th className="px-4 py-3">Snapshot Name</th>
                                        <th className="px-4 py-3">File Size</th>
                                        <th className="px-4 py-3">Created At</th>
                                        <th className="px-4 py-3 text-right">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-nature-800/60">
                                    {snapshots.map((snap) => (
                                        <tr key={snap.name} className="hover:bg-nature-900/30 transition-colors">
                                            <td className="px-4 py-3 font-mono font-bold text-white">{snap.name}</td>
                                            <td className="px-4 py-3 font-mono text-amber-400 font-bold">{fmtBytes(snap.sizeBytes)}</td>
                                            <td className="px-4 py-3 text-nature-300">{snap.createdAt}</td>
                                            <td className="px-4 py-3 text-right">
                                                <div className="flex items-center justify-end gap-2">
                                                    <a
                                                        href={`${targetSnapshotNode.url}/api/local/admin/snapshots/download?name=${encodeURIComponent(snap.name)}`}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        className="px-3 py-1 rounded-lg bg-nature-800 hover:bg-nature-700 text-sky-400 font-bold text-[11px] transition-all inline-block"
                                                    >
                                                        ⬇ Download
                                                    </a>
                                                    <button
                                                        onClick={() => handleDeleteSnapshot(snap.name)}
                                                        className="px-3 py-1 rounded-lg bg-rose-950/60 hover:bg-rose-900 text-rose-400 font-bold text-[11px] border border-rose-800/60 transition-all"
                                                    >
                                                        🗑 Delete
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                </div>
            )}

            {/* TAB 3: REPLICATION & STANDBY */}
            {activeTab === 'replication' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* Standby Cadence Form */}
                    <div className="bg-nature-950/60 border border-nature-800 p-5 rounded-2xl space-y-4">
                        <h4 className="text-xs font-extrabold text-terra-400 uppercase tracking-wider m-0">
                            Replication Pull & Reconcile Cadence ({activeNode?.name})
                        </h4>
                        <p className="text-xs text-nature-300">
                            Configure how frequently standby replicas pull incremental delta updates and routine full reconciles from the primary node over HTTPS.
                        </p>

                        <div className="space-y-4 pt-2">
                            <div>
                                <label className="block text-xs font-bold text-nature-300 mb-1">
                                    Incremental Delta Pull Interval:
                                </label>
                                <select
                                    value={pullSeconds}
                                    onChange={(e) => setPullSeconds(Number(e.target.value))}
                                    className="w-full bg-nature-900 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white font-bold focus:outline-none focus:border-terra-500"
                                >
                                    <option value={5}>5 Seconds (Aggressive)</option>
                                    <option value={20}>20 Seconds</option>
                                    <option value={30}>30 Seconds</option>
                                    <option value={60}>60 Seconds (Standard)</option>
                                    <option value={120}>2 Minutes</option>
                                </select>
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-nature-300 mb-1">
                                    Routine Full Reconcile Interval:
                                </label>
                                <select
                                    value={reconcileMinutes}
                                    onChange={(e) => setReconcileMinutes(Number(e.target.value))}
                                    className="w-full bg-nature-900 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white font-bold focus:outline-none focus:border-terra-500"
                                >
                                    <option value={15}>15 Minutes (Standard)</option>
                                    <option value={60}>1 Hour</option>
                                    <option value={360}>6 Hours</option>
                                    <option value={1440}>24 Hours</option>
                                    <option value={0}>Disabled (Delta Only)</option>
                                </select>
                            </div>

                            {cadenceMsg && (
                                <div className="p-3 rounded-xl bg-nature-900 border border-nature-700 text-xs font-bold text-white">
                                    {cadenceMsg}
                                </div>
                            )}

                            <button
                                onClick={handleSaveCadence}
                                disabled={cadenceSaving}
                                className="w-full py-2.5 rounded-xl bg-terra-500 hover:bg-terra-600 text-white font-bold text-xs shadow-lg transition-all active:scale-95 disabled:opacity-50"
                            >
                                {cadenceSaving ? 'Saving...' : 'Save Cadence Configuration'}
                            </button>
                        </div>
                    </div>

                    {/* Standby Actions & Resync */}
                    <div className="bg-nature-950/60 border border-nature-800 p-5 rounded-2xl space-y-4">
                        <h4 className="text-xs font-extrabold text-terra-400 uppercase tracking-wider m-0">
                            Standby Maintenance & Resync
                        </h4>
                        <p className="text-xs text-nature-300">
                            If a standby node experiences state divergence or orphaned drift, trigger a full force-resync to rebuild its state directly from the primary.
                        </p>

                        <div className="pt-4 border-t border-nature-800 space-y-3">
                            <button
                                onClick={handleForceResync}
                                disabled={resyncing}
                                className="w-full py-2.5 rounded-xl bg-amber-950/60 hover:bg-amber-900 text-amber-300 font-bold text-xs border border-amber-800/60 shadow-lg transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center gap-2"
                            >
                                <span className={resyncing ? 'animate-spin' : ''}>🔄</span>
                                <span>{resyncing ? 'Requesting Resync...' : 'Force Full Replication Resync'}</span>
                            </button>
                            <p className="text-[11px] text-nature-400 m-0">
                                Clears local replica state tables and requests a clean snapshot import from the primary node.
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* TAB 4: DISASTER RECOVERY RUNBOOK */}
            {activeTab === 'runbook' && (
                <div className="bg-nature-950/60 border border-nature-800 p-6 rounded-2xl space-y-6">
                    <div>
                        <h4 className="text-sm font-extrabold text-terra-400 uppercase tracking-wider m-0">
                            🛠️ Turnkey Disaster Recovery Runbook
                        </h4>
                        <p className="text-xs text-nature-300 mt-1">
                            Follow these step-by-step instructions to spawn a replacement node on a fresh VM using harvested backups and identity bundles.
                        </p>
                    </div>

                    <div className="space-y-4 text-xs text-nature-200">
                        <div className="p-4 bg-nature-900/60 border border-nature-800 rounded-xl space-y-2">
                            <div className="font-bold text-sky-400 text-sm">Step 1: Download Node Backups from Manager</div>
                            <p className="text-nature-400">
                                Click <strong className="text-white">⬇ DB</strong> and <strong className="text-white">🔑 Identity</strong> on the Harvested Fleet Backups tab to download the latest SQLite database (<code className="text-amber-400">state.db</code>) and cryptographic keys (<code className="text-emerald-400">identity-bundle.tar.gz</code>).
                            </p>
                        </div>

                        <div className="p-4 bg-nature-900/60 border border-nature-800 rounded-xl space-y-2">
                            <div className="font-bold text-sky-400 text-sm">Step 2: Provision Fresh Target VM & Docker</div>
                            <p className="text-nature-400">
                                Spin up a fresh Linux instance (Ubuntu 22.04+ or Debian 12+) and create the container directory:
                            </p>
                            <pre className="p-3 bg-nature-950 rounded-lg text-emerald-400 font-mono text-[11px] overflow-x-auto">
                                mkdir -p /root/BeanPool-Restored/data
                            </pre>
                        </div>

                        <div className="p-4 bg-nature-900/60 border border-nature-800 rounded-xl space-y-2">
                            <div className="font-bold text-sky-400 text-sm">Step 3: Extract Identity & Restore Database</div>
                            <p className="text-nature-400">
                                Copy <code className="text-amber-400">state.db</code> and extract the identity bundle tarball into <code className="text-emerald-400">/root/BeanPool-Restored/data/</code>:
                            </p>
                            <pre className="p-3 bg-nature-950 rounded-lg text-emerald-400 font-mono text-[11px] overflow-x-auto">
                                tar -xzf identity-bundle-node.tar.gz -C /root/BeanPool-Restored/data/<br />
                                cp beanpool-backup-node.db /root/BeanPool-Restored/data/state.db
                            </pre>
                        </div>

                        <div className="p-4 bg-nature-900/60 border border-nature-800 rounded-xl space-y-2">
                            <div className="font-bold text-sky-400 text-sm">Step 4: Launch Node & Sidecar</div>
                            <p className="text-nature-400">
                                Copy <code className="text-sky-400">docker-compose.yml</code> into <code className="text-sky-400">/root/BeanPool-Restored/</code> and boot:
                            </p>
                            <pre className="p-3 bg-nature-950 rounded-lg text-emerald-400 font-mono text-[11px] overflow-x-auto">
                                cd /root/BeanPool-Restored && docker compose up -d
                            </pre>
                        </div>

                        <div className="p-4 bg-nature-900/60 border border-nature-800 rounded-xl space-y-2">
                            <div className="font-bold text-emerald-400 text-sm">Step 5: Verify Restoration</div>
                            <p className="text-nature-400">
                                Navigate to the restored node&apos;s domain. The node will boot cleanly using its original identity key, rejoin the P2P network, and serve all historical member data without data loss.
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* TAB 5: DOMAIN NAME CLAIMS */}
            {activeTab === 'name-claims' && (
                <div className="space-y-6">
                    {/* Controls Banner */}
                    <div className="bg-nature-950/60 border border-nature-800 p-5 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div>
                            <h4 className="text-xs font-extrabold text-terra-400 uppercase tracking-wider m-0">
                                Sovereign Node DNS Registrar Management
                            </h4>
                            <p className="text-xs text-nature-300 m-0 mt-1">
                                Review pending domain claims, approve gated allocations, and manage active DNS mappings for sovereign nodes.
                            </p>
                        </div>
                        <div className="flex items-center gap-3">
                            <label className="flex items-center gap-2 text-xs font-bold text-nature-300 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={autoRefreshRegistrar}
                                    onChange={(e) => setAutoRefreshRegistrar(e.target.checked)}
                                    className="rounded border-nature-700 bg-nature-900 text-terra-500 focus:ring-terra-500"
                                />
                                <span>Auto-refresh (10s)</span>
                            </label>
                            <button
                                onClick={loadRegistrar}
                                disabled={registrarLoading}
                                className="px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-white font-bold text-xs border border-nature-700 transition-all flex items-center gap-2 active:scale-95 disabled:opacity-50"
                            >
                                <span className={registrarLoading ? 'animate-spin' : ''}>🔄</span>
                                <span>Reload Claims</span>
                            </button>
                        </div>
                    </div>

                    {/* Action Toast Notification */}
                    {actionToast && (
                        <div
                            className={`p-4 rounded-xl border font-bold text-xs flex items-center justify-between shadow-lg transition-all ${
                                actionToast.type === 'success'
                                    ? 'bg-emerald-950/90 border-emerald-700 text-emerald-300'
                                    : 'bg-rose-950/90 border-rose-700 text-rose-300'
                            }`}
                        >
                            <div className="flex items-center gap-2">
                                <span>{actionToast.type === 'success' ? '🎉' : '⚠️'}</span>
                                <span>{actionToast.message}</span>
                            </div>
                            <button
                                onClick={() => setActionToast(null)}
                                className="text-sm font-extrabold px-2 py-0.5 hover:bg-white/10 rounded transition-colors"
                            >
                                ✕
                            </button>
                        </div>
                    )}

                    {registrarError && (
                        <div className="p-4 rounded-xl bg-rose-950/80 border border-rose-800 text-xs font-bold text-rose-300 flex items-center justify-between">
                            <span>❌ {registrarError}</span>
                            <button onClick={loadRegistrar} className="underline text-rose-200">Retry</button>
                        </div>
                    )}

                    {/* SECTION 1: PENDING DOMAIN CLAIMS */}
                    <div className="bg-nature-950/60 border border-nature-800 rounded-2xl overflow-hidden shadow-md">
                        <div className="px-5 py-4 border-b border-nature-800 flex items-center justify-between bg-nature-900/30">
                            <div className="flex items-center gap-2">
                                <span className="text-base">⏳</span>
                                <h4 className="text-xs font-extrabold text-amber-400 uppercase tracking-wider m-0">
                                    Pending Name Claims (Tier: Gated / Awaiting Approval)
                                </h4>
                            </div>
                            <span className="text-xs font-bold text-nature-400 font-mono">
                                {registrarAllocations.filter(a => a.status === 'pending').length} Pending
                            </span>
                        </div>

                        {registrarAllocations.filter(a => a.status === 'pending').length === 0 ? (
                            <div className="p-8 text-center text-xs text-nature-400">
                                No pending domain name claims requiring approval at this time.
                            </div>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full text-left text-xs">
                                    <thead>
                                        <tr className="border-b border-nature-800 bg-nature-900/50 text-nature-400 text-[10px] uppercase font-bold tracking-wider">
                                            <th className="px-4 py-3">Domain Name</th>
                                            <th className="px-4 py-3">Community / Contact</th>
                                            <th className="px-4 py-3">Claimant Node Public Key</th>
                                            <th className="px-4 py-3">Mode</th>
                                            <th className="px-4 py-3">Requested Date</th>
                                            <th className="px-4 py-3 text-right">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-nature-800/60">
                                        {registrarAllocations.filter(a => a.status === 'pending').map((claim) => {
                                            const domainName = claim.hostname || `${claim.name}.beanpool.org`;
                                            const isConfirming = confirmAction?.name === claim.name;
                                            const confirmType = confirmAction?.type;

                                            return (
                                                <tr key={claim.name} className="hover:bg-nature-900/40 transition-colors">
                                                    <td className="px-4 py-3 font-mono font-bold text-amber-300">
                                                        <div className="text-sm">{domainName}</div>
                                                        <div className="text-[10px] text-nature-400 font-sans">
                                                            {claim.tier === 'gated' ? '🔒 Gated Name' : '🕒 Awaiting Admin Review'}
                                                        </div>
                                                    </td>
                                                    <td className="px-4 py-3 font-sans text-nature-200">
                                                        <div className="font-bold text-white text-xs">{claim.community_name || '—'}</div>
                                                        {claim.contact && (
                                                            <div className="text-[10px] text-nature-400 font-mono">{claim.contact}</div>
                                                        )}
                                                    </td>
                                                    <td className="px-4 py-3 font-mono text-nature-300">
                                                        <span className="bg-nature-900 px-2 py-1 rounded border border-nature-800 select-all" title={claim.node_pubkey}>
                                                            {claim.node_pubkey ? `${claim.node_pubkey.slice(0, 16)}…${claim.node_pubkey.slice(-8)}` : '—'}
                                                        </span>
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        <span className={`px-2.5 py-1 rounded-lg font-mono font-bold text-[10px] uppercase ${
                                                            claim.mode === 'direct'
                                                                ? 'bg-sky-950 text-sky-400 border border-sky-800'
                                                                : 'bg-indigo-950 text-indigo-400 border border-indigo-800'
                                                        }`}>
                                                            {claim.mode || 'tunnel'}
                                                        </span>
                                                    </td>
                                                    <td className="px-4 py-3 text-nature-300 font-mono">
                                                        {fmtDate(claim.requested_at)}
                                                    </td>
                                                    <td className="px-4 py-3 text-right">
                                                        {isConfirming ? (
                                                            <div className="flex items-center justify-end gap-2">
                                                                <span className="text-[11px] font-bold text-amber-300">
                                                                    Confirm {confirmType === 'approve' ? 'Approve' : 'Reject'}?
                                                                </span>
                                                                <button
                                                                    onClick={() => {
                                                                        if (confirmType === 'approve') handleApproveClaim(claim.name);
                                                                        else handleRejectClaim(claim.name);
                                                                    }}
                                                                    className={`px-3 py-1 rounded-lg font-bold text-xs text-white shadow-md transition-all active:scale-95 ${
                                                                        confirmType === 'approve'
                                                                            ? 'bg-emerald-600 hover:bg-emerald-500'
                                                                            : 'bg-rose-600 hover:bg-rose-500'
                                                                    }`}
                                                                >
                                                                    Yes, {confirmType === 'approve' ? 'Approve' : 'Reject'}
                                                                </button>
                                                                <button
                                                                    onClick={() => setConfirmAction(null)}
                                                                    className="px-2.5 py-1 rounded-lg bg-nature-800 hover:bg-nature-700 text-nature-300 text-xs font-bold"
                                                                >
                                                                    Cancel
                                                                </button>
                                                            </div>
                                                        ) : (
                                                            <div className="flex items-center justify-end gap-2">
                                                                <button
                                                                    onClick={() => setConfirmAction({ name: claim.name, type: 'approve' })}
                                                                    className="px-3.5 py-1.5 rounded-xl bg-emerald-950 hover:bg-emerald-900 text-emerald-300 border border-emerald-700/80 font-bold text-xs transition-all active:scale-95 shadow-sm flex items-center gap-1.5"
                                                                >
                                                                    <span>✅</span>
                                                                    <span>Approve</span>
                                                                </button>
                                                                <button
                                                                    onClick={() => setConfirmAction({ name: claim.name, type: 'reject' })}
                                                                    className="px-3.5 py-1.5 rounded-xl bg-rose-950 hover:bg-rose-900 text-rose-300 border border-rose-700/80 font-bold text-xs transition-all active:scale-95 shadow-sm flex items-center gap-1.5"
                                                                >
                                                                    <span>❌</span>
                                                                    <span>Reject</span>
                                                                </button>
                                                            </div>
                                                        )}
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>

                    {/* SECTION 2: ACTIVE ALLOCATIONS */}
                    <div className="bg-nature-950/60 border border-nature-800 rounded-2xl overflow-hidden shadow-md">
                        <div className="px-5 py-4 border-b border-nature-800 flex items-center justify-between bg-nature-900/30">
                            <div className="flex items-center gap-2">
                                <span className="text-base">🌐</span>
                                <h4 className="text-xs font-extrabold text-terra-400 uppercase tracking-wider m-0">
                                    Active Registrar Allocations
                                </h4>
                            </div>
                            <span className="text-xs font-bold text-nature-400 font-mono">
                                {registrarAllocations.filter(a => a.status !== 'pending').length} Total
                            </span>
                        </div>

                        {registrarAllocations.filter(a => a.status !== 'pending').length === 0 ? (
                            <div className="p-8 text-center text-xs text-nature-400">
                                No active domain name allocations found.
                            </div>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full text-left text-xs">
                                    <thead>
                                        <tr className="border-b border-nature-800 bg-nature-900/50 text-nature-400 text-[10px] uppercase font-bold tracking-wider">
                                            <th className="px-4 py-3">Domain Name</th>
                                            <th className="px-4 py-3">Community / Contact</th>
                                            <th className="px-4 py-3">Status</th>
                                            <th className="px-4 py-3">Mode</th>
                                            <th className="px-4 py-3">Public IP / Ingress</th>
                                            <th className="px-4 py-3">Attest Fails</th>
                                            <th className="px-4 py-3">Last Attest Date</th>
                                            <th className="px-4 py-3 text-right">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-nature-800/60">
                                        {registrarAllocations.filter(a => a.status !== 'pending').map((alloc) => {
                                            const domainName = alloc.hostname || `${alloc.name}.beanpool.org`;
                                            const isConfirmingRevoke = confirmAction?.name === alloc.name && confirmAction?.type === 'revoke';

                                            return (
                                                <tr key={alloc.name} className="hover:bg-nature-900/40 transition-colors">
                                                    <td className="px-4 py-3 font-mono font-bold text-white">
                                                        <div className="text-sm">{domainName}</div>
                                                        <div className="text-[10px] text-nature-400 font-sans truncate max-w-[200px]" title={alloc.node_pubkey}>
                                                            Key: {alloc.node_pubkey ? alloc.node_pubkey.slice(0, 12) + '…' : '—'}
                                                        </div>
                                                    </td>
                                                    <td className="px-4 py-3 font-sans text-nature-200">
                                                        <div className="font-bold text-white text-xs">{alloc.community_name || '—'}</div>
                                                        {alloc.contact && (
                                                            <div className="text-[10px] text-nature-400 font-mono">{alloc.contact}</div>
                                                        )}
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        {alloc.status === 'live' && (
                                                            <span className="px-2.5 py-1 rounded-lg bg-emerald-950 text-emerald-400 border border-emerald-800 font-mono font-bold text-[10px] uppercase flex items-center gap-1.5 w-fit">
                                                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                                                                <span>Live</span>
                                                            </span>
                                                        )}
                                                        {alloc.status === 'revoked' && (
                                                            <span className="px-2.5 py-1 rounded-lg bg-rose-950 text-rose-400 border border-rose-800 font-mono font-bold text-[10px] uppercase w-fit">
                                                                Revoked
                                                            </span>
                                                        )}
                                                        {alloc.status !== 'live' && alloc.status !== 'revoked' && (
                                                            <span className="px-2.5 py-1 rounded-lg bg-amber-950 text-amber-400 border border-amber-800 font-mono font-bold text-[10px] uppercase w-fit">
                                                                {alloc.status}
                                                            </span>
                                                        )}
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        <span className={`px-2 py-0.5 rounded font-mono font-bold text-[10px] uppercase ${
                                                            alloc.mode === 'direct'
                                                                ? 'bg-sky-950 text-sky-400 border border-sky-800'
                                                                : 'bg-indigo-950 text-indigo-400 border border-indigo-800'
                                                        }`}>
                                                            {alloc.mode || 'tunnel'}
                                                        </span>
                                                    </td>
                                                    <td className="px-4 py-3 font-mono text-nature-300">
                                                        {alloc.public_ip || alloc.origin || '—'}
                                                    </td>
                                                    <td className="px-4 py-3 font-mono font-bold">
                                                        <span className={alloc.attest_fails && alloc.attest_fails > 0 ? 'text-rose-400' : 'text-emerald-400'}>
                                                            {alloc.attest_fails ?? 0}
                                                        </span>
                                                    </td>
                                                    <td className="px-4 py-3 text-nature-300 font-mono">
                                                        {fmtDate(alloc.last_attest_at)}
                                                    </td>
                                                    <td className="px-4 py-3 text-right">
                                                        {alloc.status === 'revoked' ? (
                                                            <span className="text-[11px] text-nature-500 italic">Revoked</span>
                                                        ) : isConfirmingRevoke ? (
                                                            <div className="flex items-center justify-end gap-2">
                                                                <span className="text-[11px] font-bold text-rose-400">Revoke Allocation?</span>
                                                                <button
                                                                    onClick={() => handleRevokeAllocation(alloc.name)}
                                                                    className="px-3 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs shadow-md transition-all"
                                                                >
                                                                    Yes, Revoke
                                                                </button>
                                                                <button
                                                                    onClick={() => setConfirmAction(null)}
                                                                    className="px-2.5 py-1 rounded-lg bg-nature-800 hover:bg-nature-700 text-nature-300 text-xs font-bold"
                                                                >
                                                                    Cancel
                                                                </button>
                                                            </div>
                                                        ) : (
                                                            <button
                                                                onClick={() => setConfirmAction({ name: alloc.name, type: 'revoke' })}
                                                                className="px-3 py-1.5 rounded-xl bg-rose-950/70 hover:bg-rose-900 text-rose-300 border border-rose-800/80 font-bold text-xs transition-all active:scale-95 shadow-sm"
                                                            >
                                                                🚫 Revoke
                                                            </button>
                                                        )}
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* HISTORY MODAL */}
            {selectedHistoryNode && (
                <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="bg-nature-900 border border-nature-700 rounded-2xl max-w-2xl w-full p-6 space-y-4 shadow-2xl animate-scale-in">
                        <div className="flex items-center justify-between border-b border-nature-800 pb-3">
                            <h4 className="text-sm font-bold text-white m-0">
                                📅 30-Day Historical Archives ({selectedHistoryNode.name})
                            </h4>
                            <button
                                onClick={() => setSelectedHistoryNode(null)}
                                className="text-nature-400 hover:text-white font-bold text-lg leading-none"
                            >
                                ✕
                            </button>
                        </div>

                        {historyLoading ? (
                            <div className="p-6 text-center text-xs text-sky-400 animate-pulse">Loading daily archives…</div>
                        ) : historyList.length === 0 ? (
                            <div className="p-6 text-center text-xs text-nature-400">
                                No historical daily archives saved yet for this node. Archives are created automatically during daily harvests.
                            </div>
                        ) : (
                            <div className="max-h-80 overflow-y-auto rounded-xl border border-nature-800">
                                <table className="w-full text-left text-xs">
                                    <thead>
                                        <tr className="border-b border-nature-800 bg-nature-950 text-nature-400 text-[10px] uppercase font-bold tracking-wider">
                                            <th className="px-4 py-2.5">Date</th>
                                            <th className="px-4 py-2.5">Filename</th>
                                            <th className="px-4 py-2.5">Size</th>
                                            <th className="px-4 py-2.5 text-right">Action</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-nature-800/60">
                                        {historyList.map((item) => (
                                            <tr key={item.filename} className="hover:bg-nature-950/40">
                                                <td className="px-4 py-2.5 font-bold text-white">{item.date}</td>
                                                <td className="px-4 py-2.5 font-mono text-nature-300">{item.filename}</td>
                                                <td className="px-4 py-2.5 font-mono text-amber-400 font-bold">{fmtBytes(item.sizeBytes)}</td>
                                                <td className="px-4 py-2.5 text-right">
                                                    <a
                                                        href={`/api/manager/backups/download-history?nodeId=${selectedHistoryNode.id}&filename=${encodeURIComponent(item.filename)}`}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        className="px-3 py-1 rounded-lg bg-nature-800 hover:bg-nature-700 text-sky-400 font-bold text-[11px] transition-all inline-block"
                                                    >
                                                        ⬇ Download Archive
                                                    </a>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}

                        <div className="flex justify-end pt-2">
                            <button
                                onClick={() => setSelectedHistoryNode(null)}
                                className="px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white transition-all"
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
