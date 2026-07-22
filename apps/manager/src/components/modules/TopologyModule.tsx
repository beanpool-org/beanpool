import React from 'react';
import type { NodeProfile } from '../../lib/profiles';
import type { DiagnosticsResponse } from '../../lib/node-client';

interface TopologyModuleProps {
    activeNode: NodeProfile;
    diag: DiagnosticsResponse | null;
    onRefresh: () => void;
}

export function TopologyModule({ activeNode, diag, onRefresh }: TopologyModuleProps) {
    return (
        <div className="bg-nature-900/80 border border-nature-800 rounded-2xl p-6 space-y-6 shadow-xl font-sans animate-fade-in">
            <div className="flex items-center justify-between">
                <div>
                    <h3 className="text-lg font-bold text-white m-0">🗄️ Node Replication & Backup Topology</h3>
                    <p className="text-xs text-nature-400 m-0 mt-1">
                        Manage primary replication tokens, enrolled backup standby nodes, auto-snapshots, and failover runbooks.
                    </p>
                </div>
                <button
                    onClick={onRefresh}
                    className="px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all flex items-center gap-2 active:scale-95"
                >
                    <span>🔄</span>
                    <span>Refresh Topology</span>
                </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Replication Status */}
                <div className="bg-nature-950/60 border border-nature-800 p-5 rounded-2xl space-y-4">
                    <div className="flex items-center justify-between">
                        <h4 className="text-xs font-extrabold text-terra-400 uppercase tracking-wider">
                            Replication Mode & Credentials
                        </h4>
                        <span className="px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800 font-mono text-[10px] font-bold">
                            ACTIVE
                        </span>
                    </div>

                    <div className="space-y-3 text-xs">
                        <div className="flex justify-between items-center pb-2 border-b border-nature-800/60">
                            <span className="text-nature-400 font-semibold">Target Node URL:</span>
                            <code className="text-sky-400 font-mono font-bold">{activeNode?.url}</code>
                        </div>
                        <div className="flex justify-between items-center pb-2 border-b border-nature-800/60">
                            <span className="text-nature-400 font-semibold">Topology Mode:</span>
                            <span className="text-emerald-400 font-bold">Sovereign Dual-Role (Primary / Standby Pull)</span>
                        </div>
                        <div className="flex justify-between items-center">
                            <span className="text-nature-400 font-semibold">Database Engine File:</span>
                            <span className="text-amber-400 font-mono font-bold">
                                {diag ? `${(diag.dbSizeBytes / (1024 * 1024)).toFixed(2)} MB` : 'Connecting...'}
                            </span>
                        </div>
                    </div>
                </div>

                {/* Cloudflare Active-Passive Failover Runbook */}
                <div className="bg-nature-950/60 border border-nature-800 p-5 rounded-2xl space-y-4">
                    <h4 className="text-xs font-extrabold text-terra-400 uppercase tracking-wider">
                        Active-Passive Failover Topology
                    </h4>
                    <p className="text-xs text-nature-300 leading-relaxed">
                        BeanPool ledger engine relies on CRDT state convergence. When operating multi-node deployments with DNS load balancing:
                    </p>
                    <ul className="text-xs text-nature-400 space-y-1.5 list-disc list-inside">
                        <li>Configure Cloudflare Load Balancer in <strong className="text-white">Active-Passive (Failover)</strong> mode.</li>
                        <li>All client mutations pin to the primary active node.</li>
                        <li>Standby replicas pull encrypted delta snapshots via scoped replication tokens.</li>
                    </ul>
                </div>
            </div>
        </div>
    );
}
