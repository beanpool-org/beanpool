import React, { useState, useEffect } from 'react';
import { loadNodeProfiles, saveNodeProfiles, addNodeProfile, removeNodeProfile, type NodeProfile } from './lib/profiles';
import { fetchDiagnostics, fetchGatewayConfig, updateGatewayConfig, normalizeNodeUrl, type DiagnosticsResponse, type GatewayConfig } from './lib/node-client';
import { computeSampleTrustSummary } from './lib/engine-helpers';

export function App() {
    const [profiles, setProfiles] = useState<NodeProfile[]>(() => loadNodeProfiles());
    const [activeProfileId, setActiveProfileId] = useState<string>(() => profiles[0]?.id || 'local-node');
    const [activeTab, setActiveTab] = useState<'overview' | 'gateway' | 'members' | 'topology' | 'logs'>('overview');

    const activeNode = profiles.find(p => p.id === activeProfileId) || profiles[0];

    const [diag, setDiag] = useState<DiagnosticsResponse | null>(null);
    const [diagLoading, setDiagLoading] = useState(false);
    const [diagError, setDiagError] = useState<string | null>(null);

    const [gateway, setGateway] = useState<GatewayConfig | null>(null);
    const [gatewayLoading, setGatewayLoading] = useState(false);
    const [gatewaySuccess, setGatewaySuccess] = useState<string | null>(null);

    const [showAddModal, setShowAddModal] = useState(false);
    const [newNodeName, setNewNodeName] = useState('');
    const [newNodeUrl, setNewNodeUrl] = useState('');
    const [newNodePassword, setNewNodePassword] = useState('');

    const [adminPasswordInput, setAdminPasswordInput] = useState(activeNode?.adminPassword || '');

    useEffect(() => {
        setAdminPasswordInput(activeNode?.adminPassword || '');
    }, [activeProfileId]);

    // Refresh Telemetry Diagnostics
    const loadDiagnostics = async () => {
        if (!activeNode) return;
        setDiagLoading(true);
        setDiagError(null);
        try {
            const data = await fetchDiagnostics(activeNode.url, adminPasswordInput);
            setDiag(data);
        } catch (e: any) {
            setDiagError(e.message || 'Failed to connect to node');
            setDiag(null);
        } finally {
            setDiagLoading(false);
        }
    };

    // Refresh Gateway Config
    const loadGateway = async () => {
        if (!activeNode) return;
        setGatewayLoading(true);
        try {
            const data = await fetchGatewayConfig(activeNode.url, adminPasswordInput);
            setGateway(data);
        } catch (e: any) {
            console.warn('[Manager] Could not fetch gateway config:', e);
        } finally {
            setGatewayLoading(false);
        }
    };

    useEffect(() => {
        loadDiagnostics();
        loadGateway();
    }, [activeProfileId]);

    const handleSaveGateway = async () => {
        if (!activeNode || !gateway) return;
        setGatewaySuccess(null);
        try {
            const updated = await updateGatewayConfig(activeNode.url, gateway, adminPasswordInput);
            setGateway(updated);
            setGatewaySuccess('✅ Gateway configuration updated successfully!');
            setTimeout(() => setGatewaySuccess(null), 3000);
        } catch (e: any) {
            alert('Failed to update gateway: ' + e.message);
        }
    };

    const handleAddNode = (e: React.FormEvent) => {
        e.preventDefault();
        if (!newNodeName.trim() || !newNodeUrl.trim()) return;
        const created = addNodeProfile({
            name: newNodeName.trim(),
            url: normalizeNodeUrl(newNodeUrl),
            adminPassword: newNodePassword.trim() || undefined,
        });
        setProfiles(loadNodeProfiles());
        setActiveProfileId(created.id);
        setShowAddModal(false);
        setNewNodeName('');
        setNewNodeUrl('');
        setNewNodePassword('');
    };

    const handleRemoveNode = (id: string) => {
        if (profiles.length <= 1) {
            alert('Cannot delete the last node profile.');
            return;
        }
        if (confirm('Are you sure you want to remove this node from your fleet manager?')) {
            removeNodeProfile(id);
            const remaining = loadNodeProfiles();
            setProfiles(remaining);
            setActiveProfileId(remaining[0].id);
        }
    };

    // Calculate sample trust score using re-exported @beanpool/engine helper
    const sampleTrust = computeSampleTrustSummary(4, 18, 0, 120);

    return (
        <div className="min-h-screen bg-nature-950 text-nature-100 flex flex-col font-sans">
            {/* Top Navbar */}
            <header className="border-b border-nature-800/80 bg-nature-900/90 backdrop-blur-md px-6 py-4 flex flex-wrap items-center justify-between gap-4 sticky top-0 z-40">
                <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-terra-500 flex items-center justify-center font-bold text-white shadow-md">
                        🌱
                    </div>
                    <div>
                        <h1 className="text-lg font-bold tracking-tight text-white m-0">BeanPool Fleet Manager</h1>
                        <p className="text-xs text-nature-400 m-0">Decoupled Multi-Node Control Plane</p>
                    </div>
                </div>

                {/* Active Node Switcher */}
                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2 bg-nature-950/80 border border-nature-800 rounded-xl px-3 py-1.5 text-xs font-mono">
                        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                        <select
                            value={activeProfileId}
                            onChange={(e) => setActiveProfileId(e.target.value)}
                            className="bg-transparent text-white focus:outline-none cursor-pointer"
                        >
                            {profiles.map(p => (
                                <option key={p.id} value={p.id} className="bg-nature-900 text-white">
                                    {p.name} ({p.url})
                                </option>
                            ))}
                        </select>
                    </div>
                    <button
                        onClick={() => setShowAddModal(true)}
                        className="px-3 py-1.5 rounded-xl bg-nature-800 hover:bg-nature-700 text-white text-xs font-bold transition-all border border-nature-700"
                    >
                        + Add Node
                    </button>
                    {profiles.length > 1 && (
                        <button
                            onClick={() => handleRemoveNode(activeProfileId)}
                            className="px-2 py-1.5 rounded-xl bg-red-900/40 hover:bg-red-900/60 text-red-300 text-xs font-bold transition-all border border-red-800"
                            title="Remove Active Node"
                        >
                            🗑️
                        </button>
                    )}
                </div>
            </header>

            {/* Sub-header Navigation Tabs */}
            <div className="border-b border-nature-800/60 bg-nature-900/40 px-6 flex gap-6 text-sm font-semibold overflow-x-auto">
                <button
                    onClick={() => setActiveTab('overview')}
                    className={`py-3.5 border-b-2 transition-all ${activeTab === 'overview' ? 'border-terra-500 text-white' : 'border-transparent text-nature-400 hover:text-nature-200'}`}
                >
                    📊 Fleet Overview & Telemetry
                </button>
                <button
                    onClick={() => setActiveTab('gateway')}
                    className={`py-3.5 border-b-2 transition-all ${activeTab === 'gateway' ? 'border-terra-500 text-white' : 'border-transparent text-nature-400 hover:text-nature-200'}`}
                >
                    🛡️ Gateway & Feature Toggles
                </button>
                <button
                    onClick={() => setActiveTab('members')}
                    className={`py-3.5 border-b-2 transition-all ${activeTab === 'members' ? 'border-terra-500 text-white' : 'border-transparent text-nature-400 hover:text-nature-200'}`}
                >
                    👥 Members & Trust Engine
                </button>
                <button
                    onClick={() => setActiveTab('topology')}
                    className={`py-3.5 border-b-2 transition-all ${activeTab === 'topology' ? 'border-terra-500 text-white' : 'border-transparent text-nature-400 hover:text-nature-200'}`}
                >
                    🗄️ Replication & Backups
                </button>
                <button
                    onClick={() => setActiveTab('logs')}
                    className={`py-3.5 border-b-2 transition-all ${activeTab === 'logs' ? 'border-terra-500 text-white' : 'border-transparent text-nature-400 hover:text-nature-200'}`}
                >
                    📜 System Logs Streamer
                </button>
            </div>

            {/* Main Content Area */}
            <main className="flex-1 max-w-7xl w-full mx-auto p-6 space-y-6">

                {/* Auth Password bar */}
                <div className="bg-nature-900/60 border border-nature-800 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-4 text-xs">
                    <div className="flex items-center gap-2">
                        <span className="text-nature-400">Target Node API:</span>
                        <code className="bg-nature-950 px-2.5 py-1 rounded-lg border border-nature-800 text-terra-400 font-mono">
                            {activeNode?.url}
                        </code>
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="text-nature-400">Admin Password:</span>
                        <input
                            type="password"
                            value={adminPasswordInput}
                            onChange={(e) => setAdminPasswordInput(e.target.value)}
                            placeholder="Enter Node Admin Password"
                            className="bg-nature-950 border border-nature-800 px-3 py-1 rounded-lg text-white font-mono focus:outline-none focus:border-terra-500 w-48 text-xs"
                        />
                        <button
                            onClick={() => { loadDiagnostics(); loadGateway(); }}
                            className="px-3 py-1 rounded-lg bg-terra-600 hover:bg-terra-500 text-white font-bold transition-all"
                        >
                            Authenticate
                        </button>
                    </div>
                </div>

                {/* TAB 1: FLEET OVERVIEW & TELEMETRY */}
                {activeTab === 'overview' && (
                    <div className="space-y-6">
                        <div className="flex items-center justify-between">
                            <h2 className="text-lg font-bold text-white">Live Node Telemetry & Hardware Diagnostics</h2>
                            <button
                                onClick={loadDiagnostics}
                                disabled={diagLoading}
                                className="px-3 py-1.5 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all"
                            >
                                {diagLoading ? 'Refreshing...' : '🔄 Refresh Data'}
                            </button>
                        </div>

                        {diagError ? (
                            <div className="p-4 rounded-2xl bg-red-900/20 border border-red-800 text-red-300 text-sm">
                                ❌ Connection Error: {diagError}. Make sure the node is running and CORS allows origin.
                            </div>
                        ) : diag ? (
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                                <div className="bg-nature-900/80 border border-nature-800 rounded-2xl p-5 space-y-2">
                                    <div className="text-xs text-nature-400 uppercase font-bold tracking-wider">Node Status</div>
                                    <div className="text-xl font-bold text-emerald-400 flex items-center gap-2">
                                        <span className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse"></span>
                                        {diag.status.toUpperCase()}
                                    </div>
                                    <div className="text-xs text-nature-500">{diag.communityName || 'BeanPool Community Node'}</div>
                                </div>

                                <div className="bg-nature-900/80 border border-nature-800 rounded-2xl p-5 space-y-2">
                                    <div className="text-xs text-nature-400 uppercase font-bold tracking-wider">Process Uptime</div>
                                    <div className="text-xl font-bold text-white font-mono">
                                        {Math.floor(diag.uptimeSeconds / 3600)}h {Math.floor((diag.uptimeSeconds % 3600) / 60)}m {diag.uptimeSeconds % 60}s
                                    </div>
                                    <div className="text-xs text-nature-500">Active server thread</div>
                                </div>

                                <div className="bg-nature-900/80 border border-nature-800 rounded-2xl p-5 space-y-2">
                                    <div className="text-xs text-nature-400 uppercase font-bold tracking-wider">Active Connections</div>
                                    <div className="text-xl font-bold text-sky-400 font-mono">
                                        {diag.activeWsConnections} WebSockets / {diag.p2pActivePeers} P2P Peers
                                    </div>
                                    <div className="text-xs text-nature-500">Live client streams</div>
                                </div>

                                <div className="bg-nature-900/80 border border-nature-800 rounded-2xl p-5 space-y-2">
                                    <div className="text-xs text-nature-400 uppercase font-bold tracking-wider">Database Engine</div>
                                    <div className="text-xl font-bold text-amber-400 font-mono">
                                        {(diag.dbSizeBytes / (1024 * 1024)).toFixed(2)} MB
                                    </div>
                                    <div className="text-xs text-nature-500">WAL: {(diag.walSizeBytes / 1024).toFixed(1)} KB (SQLite)</div>
                                </div>
                            </div>
                        ) : (
                            <div className="p-8 text-center text-nature-500 text-sm">
                                Loading live node telemetry...
                            </div>
                        )}
                    </div>
                )}

                {/* TAB 2: GATEWAY & FEATURE TOGGLES */}
                {activeTab === 'gateway' && gateway && (
                    <div className="bg-nature-900/80 border border-nature-800 rounded-2xl p-6 space-y-6">
                        <div className="flex items-center justify-between border-b border-nature-800 pb-4">
                            <div>
                                <h3 className="text-base font-bold text-white m-0">🛡️ Node Gateway Self-Protection Config</h3>
                                <p className="text-xs text-nature-400 m-0 mt-1">Configure CORS allowed origins, IP allowlists, rate limiting, and subsystem feature flags.</p>
                            </div>
                            <button
                                onClick={handleSaveGateway}
                                className="px-4 py-2 rounded-xl bg-terra-500 hover:bg-terra-600 font-bold text-white text-xs transition-all shadow-md"
                            >
                                💾 Save Gateway Config
                            </button>
                        </div>

                        {gatewaySuccess && (
                            <div className="p-3 rounded-xl bg-emerald-900/30 border border-emerald-800 text-emerald-300 text-xs font-mono">
                                {gatewaySuccess}
                            </div>
                        )}

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            {/* Feature Toggles */}
                            <div className="space-y-3">
                                <h4 className="text-xs font-bold text-nature-300 uppercase tracking-wider">Subsystem Feature Toggles</h4>
                                <div className="space-y-2 bg-nature-950/60 p-4 rounded-xl border border-nature-800/60 text-xs">
                                    <label className="flex items-center justify-between cursor-pointer">
                                        <span>🛒 Marketplace (Posts & Escrow)</span>
                                        <input
                                            type="checkbox"
                                            checked={gateway.features.marketplace}
                                            onChange={(e) => setGateway({ ...gateway, features: { ...gateway.features, marketplace: e.target.checked } })}
                                            className="w-4 h-4 rounded accent-terra-500"
                                        />
                                    </label>
                                    <label className="flex items-center justify-between cursor-pointer">
                                        <span>💬 Messaging Threads</span>
                                        <input
                                            type="checkbox"
                                            checked={gateway.features.messaging}
                                            onChange={(e) => setGateway({ ...gateway, features: { ...gateway.features, messaging: e.target.checked } })}
                                            className="w-4 h-4 rounded accent-terra-500"
                                        />
                                    </label>
                                    <label className="flex items-center justify-between cursor-pointer">
                                        <span>🌐 Inter-Community Federation</span>
                                        <input
                                            type="checkbox"
                                            checked={gateway.features.federation}
                                            onChange={(e) => setGateway({ ...gateway, features: { ...gateway.features, federation: e.target.checked } })}
                                            className="w-4 h-4 rounded accent-terra-500"
                                        />
                                    </label>
                                    <label className="flex items-center justify-between cursor-pointer">
                                        <span>🎟️ Invite Redemption</span>
                                        <input
                                            type="checkbox"
                                            checked={gateway.features.invites}
                                            onChange={(e) => setGateway({ ...gateway, features: { ...gateway.features, invites: e.target.checked } })}
                                            className="w-4 h-4 rounded accent-terra-500"
                                        />
                                    </label>
                                    <label className="flex items-center justify-between cursor-pointer">
                                        <span>📱 Serve Node-Hosted PWA</span>
                                        <input
                                            type="checkbox"
                                            checked={gateway.features.servePwa}
                                            onChange={(e) => setGateway({ ...gateway, features: { ...gateway.features, servePwa: e.target.checked } })}
                                            className="w-4 h-4 rounded accent-terra-500"
                                        />
                                    </label>
                                </div>
                            </div>

                            {/* CORS & Rate Limiting */}
                            <div className="space-y-3">
                                <h4 className="text-xs font-bold text-nature-300 uppercase tracking-wider">Rate Limiting & Security</h4>
                                <div className="space-y-3 bg-nature-950/60 p-4 rounded-xl border border-nature-800/60 text-xs">
                                    <label className="flex items-center justify-between cursor-pointer">
                                        <span>⏱️ Rate Limiting Enabled</span>
                                        <input
                                            type="checkbox"
                                            checked={gateway.rateLimiting.enabled}
                                            onChange={(e) => setGateway({ ...gateway, rateLimiting: { ...gateway.rateLimiting, enabled: e.target.checked } })}
                                            className="w-4 h-4 rounded accent-terra-500"
                                        />
                                    </label>
                                    <div>
                                        <span className="text-nature-400 block mb-1">Max Requests Per Minute:</span>
                                        <input
                                            type="number"
                                            value={gateway.rateLimiting.maxRequestsPerMinute}
                                            onChange={(e) => setGateway({ ...gateway, rateLimiting: { ...gateway.rateLimiting, maxRequestsPerMinute: parseInt(e.target.value) || 120 } })}
                                            className="w-full bg-nature-900 border border-nature-800 px-3 py-1.5 rounded-lg text-white font-mono text-xs focus:outline-none"
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* TAB 3: MEMBERS & TRUST ENGINE */}
                {activeTab === 'members' && (
                    <div className="bg-nature-900/80 border border-nature-800 rounded-2xl p-6 space-y-6">
                        <div>
                            <h3 className="text-base font-bold text-white m-0">👥 Sovereign Trust Engine Inspector (`@beanpool/engine`)</h3>
                            <p className="text-xs text-nature-400 m-0 mt-1">Calculates node member trust score & standing using pure exported engine algorithms.</p>
                        </div>

                        <div className="bg-nature-950/60 border border-nature-800 p-5 rounded-xl space-y-4">
                            <h4 className="text-xs font-bold text-terra-400 uppercase tracking-wider">Sample Member Trust Computation</h4>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
                                <div>
                                    <span className="text-nature-500 block">Vouchers:</span>
                                    <span className="font-mono font-bold text-white">4 Vouchers</span>
                                </div>
                                <div>
                                    <span className="text-nature-500 block">Completed Deals:</span>
                                    <span className="font-mono font-bold text-white">18 Trades</span>
                                </div>
                                <div>
                                    <span className="text-nature-500 block">Disputes:</span>
                                    <span className="font-mono font-bold text-emerald-400">0 Disputes</span>
                                </div>
                                <div>
                                    <span className="text-nature-500 block">Calculated Trust Level:</span>
                                    <span className="font-mono font-bold text-amber-400 uppercase">{sampleTrust.trustLevel}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* TAB 4: REPLICATION & TOPOLOGY */}
                {activeTab === 'topology' && (
                    <div className="bg-nature-900/80 border border-nature-800 rounded-2xl p-6 space-y-4">
                        <h3 className="text-base font-bold text-white m-0">🗄️ Node Replication & Backup Topology</h3>
                        <p className="text-xs text-nature-400 m-0">Manage primary replication tokens, enrolled backup nodes, and auto-snapshots.</p>
                        <div className="p-4 rounded-xl bg-nature-950/60 border border-nature-800 text-xs text-nature-300 font-mono">
                            Replication Mode: Sovereign Dual-Role (Primary / Backup pull enabled)
                        </div>
                    </div>
                )}

                {/* TAB 5: SYSTEM LOGS STREAMER */}
                {activeTab === 'logs' && (
                    <div className="bg-nature-900/80 border border-nature-800 rounded-2xl p-6 space-y-4">
                        <h3 className="text-base font-bold text-white m-0">📜 Real-Time Node Logs Streamer</h3>
                        <div className="h-64 bg-nature-950 border border-nature-800 rounded-xl p-4 font-mono text-xs overflow-y-auto space-y-1 text-nature-300">
                            <div>[INFO] Gateway security middlewares initialized</div>
                            <div>[INFO] Koa server listening on port 8443</div>
                            <div>[DEBUG] Database WAL checkpoint completed (0 pages remaining)</div>
                            <div>[INFO] Active WebSocket stream connected for node admin</div>
                        </div>
                    </div>
                )}
            </main>

            {/* Add Node Modal */}
            {showAddModal && (
                <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50">
                    <div className="bg-nature-900 border border-nature-800 rounded-2xl p-6 max-w-md w-full space-y-4 shadow-2xl">
                        <h3 className="text-base font-bold text-white m-0">Connect New Sovereign Node</h3>
                        <form onSubmit={handleAddNode} className="space-y-4 text-xs">
                            <div>
                                <label className="block text-nature-400 mb-1">Node Display Name</label>
                                <input
                                    type="text"
                                    value={newNodeName}
                                    onChange={(e) => setNewNodeName(e.target.value)}
                                    placeholder="e.g. Byron Bay Primary"
                                    required
                                    className="w-full bg-nature-950 border border-nature-800 px-3 py-2 rounded-xl text-white focus:outline-none focus:border-terra-500"
                                />
                            </div>
                            <div>
                                <label className="block text-nature-400 mb-1">Node API Base URL</label>
                                <input
                                    type="url"
                                    value={newNodeUrl}
                                    onChange={(e) => setNewNodeUrl(e.target.value)}
                                    placeholder="https://node2.beanpool.org"
                                    required
                                    className="w-full bg-nature-950 border border-nature-800 px-3 py-2 rounded-xl text-white font-mono focus:outline-none focus:border-terra-500"
                                />
                            </div>
                            <div>
                                <label className="block text-nature-400 mb-1">Admin Password (Optional)</label>
                                <input
                                    type="password"
                                    value={newNodePassword}
                                    onChange={(e) => setNewNodePassword(e.target.value)}
                                    placeholder="Admin Password"
                                    className="w-full bg-nature-950 border border-nature-800 px-3 py-2 rounded-xl text-white font-mono focus:outline-none focus:border-terra-500"
                                />
                            </div>
                            <div className="flex justify-end gap-3 pt-2">
                                <button
                                    type="button"
                                    onClick={() => setShowAddModal(false)}
                                    className="px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-white font-bold transition-all"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    className="px-4 py-2 rounded-xl bg-terra-500 hover:bg-terra-600 text-white font-bold transition-all shadow-sm"
                                >
                                    Save Node
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
