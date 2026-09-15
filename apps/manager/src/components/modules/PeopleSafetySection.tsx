import React, { useState } from 'react';
import { MembersModule, type MemberItem, type NodeDataPayload } from './MembersModule';
import { type MemberNodeRole } from './MemberDetailModal';
import { InvitesModule } from './InvitesModule';
import { ThreatReviewModal, type ThreatItem } from './ThreatReviewModal';
import type { NodeProfile } from '../../lib/profiles';
import { resolveNodeApiUrl, buildAdminHeaders, getTfaSessionToken } from '../../lib/node-client';

interface PeopleSafetySectionProps {
    activeNode: NodeProfile;
    nodeData: NodeDataPayload | null;
    nodeDataLoading: boolean;
    onRefresh: () => void;
    onFreezeUser: (pubkey: string, freeze: boolean) => Promise<void>;
    onPruneUser: (pubkey: string) => Promise<void>;
    onUpdateTier: (pubkey: string, tier: 'Newcomer' | 'Resident' | 'Steward' | 'Elder') => Promise<void>;
    onToggleVoucher: (pubkey: string, canVouch: boolean) => Promise<void>;
    onToggleOperator: (pubkey: string, canOperate: boolean) => Promise<void>;
    onGrantNodeRole?: (pubkey: string, role: MemberNodeRole) => Promise<void>;
    onRevokeNodeRole?: (pubkey: string, role: MemberNodeRole) => Promise<void>;
    initialSubTab?: 'directory' | 'invites' | 'moderation';
}

export function PeopleSafetySection({
    activeNode,
    nodeData,
    nodeDataLoading,
    onRefresh,
    onFreezeUser,
    onPruneUser,
    onUpdateTier,
    onToggleVoucher,
    onToggleOperator,
    onGrantNodeRole,
    onRevokeNodeRole,
    initialSubTab = 'directory',
}: PeopleSafetySectionProps) {
    const [subTab, setSubTab] = useState<'directory' | 'invites' | 'moderation'>(initialSubTab);
    const [selectedThreat, setSelectedThreat] = useState<ThreatItem | null>(null);
    const [bulkDeleteDays, setBulkDeleteDays] = useState(30);
    const [bulkDeleting, setBulkDeleting] = useState(false);
    const [bulkDeleteResult, setBulkDeleteResult] = useState<string | null>(null);

    const reports = nodeData?.reports || [];

    const handleBulkDeletePosts = async () => {
        if (!confirm(`Permanently delete all posts older than ${bulkDeleteDays} days?`)) return;
        setBulkDeleting(true);
        setBulkDeleteResult(null);
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/posts/bulk-delete');
            const res = await fetch(url, {
                method: 'POST',
                headers: buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
                body: JSON.stringify({ days: bulkDeleteDays }),
            });
            const data = await res.json();
            if (res.ok) {
                setBulkDeleteResult(`Deleted ${data.deletedCount ?? 0} post(s).`);
                onRefresh();
            } else {
                setBulkDeleteResult(`Failed: ${data.error || 'Unknown error'}`);
            }
        } catch (e: unknown) {
            setBulkDeleteResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setBulkDeleting(false);
        }
    };

    return (
        <div className="space-y-6 font-sans animate-fade-in">
            {/* Header & Sub-Navigation */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-nature-800 pb-4">
                <div>
                    <h2 className="text-xl font-black text-white m-0 tracking-tight flex items-center gap-2.5">
                        <span>👥</span>
                        <span>People &amp; Safety</span>
                    </h2>
                    <p className="text-xs text-nature-400 m-0 mt-1">
                        Member directory, trust tiers, invites, QR cards, and report triage
                    </p>
                </div>

                <div className="flex items-center gap-1.5 bg-nature-950 p-1.5 rounded-xl border border-nature-800 self-start sm:self-auto">
                    <button
                        onClick={() => setSubTab('directory')}
                        className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                            subTab === 'directory'
                                ? 'bg-terra-500/20 text-terra-300 border border-terra-500/40 shadow-sm'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        Members ({nodeData?.members?.length ?? 0})
                    </button>
                    <button
                        onClick={() => setSubTab('invites')}
                        className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                            subTab === 'invites'
                                ? 'bg-terra-500/20 text-terra-300 border border-terra-500/40 shadow-sm'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        Invites &amp; QR
                    </button>
                    <button
                        onClick={() => setSubTab('moderation')}
                        className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                            subTab === 'moderation'
                                ? 'bg-terra-500/20 text-terra-300 border border-terra-500/40 shadow-sm'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        <span>Triage &amp; Moderation</span>
                        {reports.length > 0 && (
                            <span className="px-1.5 py-0.2 rounded-full bg-amber-500 text-black text-[10px] font-bold">
                                {reports.length}
                            </span>
                        )}
                    </button>
                </div>
            </div>

            {/* Sub-tab content */}
            {subTab === 'directory' && (
                <MembersModule
                    nodeData={nodeData}
                    nodeDataLoading={nodeDataLoading}
                    activeNodeUrl={activeNode.url}
                    adminPassword={activeNode.adminPassword}
                    onRefresh={onRefresh}
                    onFreezeUser={onFreezeUser}
                    onPruneUser={onPruneUser}
                    onUpdateTier={onUpdateTier}
                    onToggleVoucher={onToggleVoucher}
                    onToggleOperator={onToggleOperator}
                    onGrantNodeRole={onGrantNodeRole}
                    onRevokeNodeRole={onRevokeNodeRole}
                />
            )}

            {subTab === 'invites' && (
                <InvitesModule activeNode={activeNode} />
            )}

            {subTab === 'moderation' && (
                <div className="space-y-6">
                    {/* Pending Reports List */}
                    <div className="bg-nature-900/80 border border-nature-800 rounded-2xl p-6 shadow-xl space-y-4">
                        <div className="flex items-center justify-between border-b border-nature-800 pb-3">
                            <div>
                                <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                                    <span>⚠️</span>
                                    <span>Community Report Triage</span>
                                </h3>
                                <p className="text-xs text-nature-400 m-0 mt-0.5">
                                    Member-reported abuse, harassment, or invalid listings requiring operator action
                                </p>
                            </div>
                            <button
                                onClick={onRefresh}
                                className="px-3 py-1.5 rounded-lg bg-nature-800 hover:bg-nature-700 text-xs text-white font-bold transition-all"
                            >
                                Refresh
                            </button>
                        </div>

                        {reports.length === 0 ? (
                            <div className="py-8 text-center text-sm font-semibold text-emerald-400 bg-emerald-950/20 border border-emerald-900/40 rounded-xl">
                                🟢 No pending reports. The community queue is all clear.
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {reports.map((report: any, idx: number) => (
                                    <div
                                        key={report.id || idx}
                                        className="p-4 rounded-xl bg-nature-950 border border-nature-800 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 hover:border-nature-700 transition-colors"
                                    >
                                        <div className="space-y-1">
                                            <div className="flex items-center gap-2">
                                                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30">
                                                    {report.severity || 'Report'}
                                                </span>
                                                <span className="text-xs font-mono text-nature-300">
                                                    Target: {report.targetPubkey?.slice(0, 16) || 'Unknown'}...
                                                </span>
                                            </div>
                                            <p className="text-xs text-white m-0">
                                                {report.reason || report.description || 'No reason provided'}
                                            </p>
                                        </div>
                                        <div className="flex items-center gap-2 self-end sm:self-auto">
                                            <button
                                                onClick={() => setSelectedThreat(report)}
                                                className="px-3 py-1.5 rounded-lg bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all shadow-sm"
                                            >
                                                Inspect &amp; Action
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Bulk Post Cleanup (Absorbs capability from old moderation tab) */}
                    <div className="bg-nature-900/80 border border-nature-800 rounded-2xl p-6 shadow-xl space-y-4">
                        <div className="border-b border-nature-800 pb-3">
                            <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                                <span>🧹</span>
                                <span>Bulk Content Cleanup</span>
                            </h3>
                            <p className="text-xs text-nature-400 m-0 mt-0.5">
                                Prune stale expired offers, needs, and marketplace posts from the local database
                            </p>
                        </div>

                        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                            <div className="flex items-center gap-2">
                                <label className="text-xs font-semibold text-nature-300">Older than:</label>
                                <select
                                    value={bulkDeleteDays}
                                    onChange={(e) => setBulkDeleteDays(Number(e.target.value))}
                                    className="bg-nature-950 border border-nature-700 rounded-lg px-3 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-terra-500"
                                >
                                    <option value={7}>7 days</option>
                                    <option value={14}>14 days</option>
                                    <option value={30}>30 days</option>
                                    <option value={60}>60 days</option>
                                    <option value={90}>90 days</option>
                                </select>
                            </div>

                            <button
                                onClick={handleBulkDeletePosts}
                                disabled={bulkDeleting}
                                className="px-4 py-2 rounded-xl bg-red-900/80 hover:bg-red-800 text-xs font-bold text-white border border-red-700 transition-all disabled:opacity-50"
                            >
                                {bulkDeleting ? 'Pruning...' : 'Prune Stale Posts'}
                            </button>

                            {bulkDeleteResult && (
                                <span className="text-xs font-mono text-terra-300">{bulkDeleteResult}</span>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Threat Review Modal */}
            {selectedThreat && (
                <ThreatReviewModal
                    threat={selectedThreat}
                    members={nodeData?.members as any}
                    onClose={() => setSelectedThreat(null)}
                    onDismiss={() => {
                        setSelectedThreat(null);
                        onRefresh();
                    }}
                    onFreezePubkeys={async (pks) => {
                        for (const pk of pks) {
                            await onFreezeUser(pk, true);
                        }
                        setSelectedThreat(null);
                        onRefresh();
                    }}
                />
            )}
        </div>
    );
}
