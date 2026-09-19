import React, { useState, useEffect } from 'react';
import { HelpLink } from '../manual/Manual';
import { SubTabStrip } from '../layout/SubTabStrip';
import { useSectionSubTab } from '../../lib/sections';
import { MembersModule, type MemberItem, type NodeDataPayload } from './MembersModule';
import { type MemberNodeRole } from './MemberDetailModal';
import { InvitesModule } from './InvitesModule';
import { ThreatReviewModal, type ThreatItem } from './ThreatReviewModal';
import { PostModerationPanel } from './PostModerationPanel';
import { AncestryTreePanel } from './AncestryTreePanel';
import { NodeRolesPanel, type RolesViewer } from './NodeRolesPanel';
import { SectionErrorBoundary } from '../common/SectionErrorBoundary';
import type { NodeProfile } from '../../lib/profiles';
import { resolveNodeApiUrl, buildAdminHeaders, getTfaSessionToken, pruneInviteBranch, removeReportedPulseItem, dismissNodeReport, fetchReports, type NodeReport } from '../../lib/node-client';

interface PeopleSafetySectionProps {
    activeNode: NodeProfile;
    nodeData: NodeDataPayload | null;
    nodeDataLoading: boolean;
    onRefresh: () => void;
    onFreezeUser: (pubkey: string, freeze: boolean) => Promise<void>;
    onPruneUser: (pubkey: string) => Promise<void>;
    onPruneBranch?: (pubkey: string) => Promise<void>;
    onUpdateTier: (pubkey: string, tier: 'Newcomer' | 'Resident' | 'Steward' | 'Elder') => Promise<void>;
    onToggleVoucher: (pubkey: string, canVouch: boolean) => Promise<void>;
    onToggleOperator: (pubkey: string, canOperate: boolean) => Promise<void>;
    onGrantNodeRole?: (pubkey: string, role: MemberNodeRole) => Promise<void>;
    onRevokeNodeRole?: (pubkey: string, role: MemberNodeRole) => Promise<void>;
    initialSubTab?: 'directory' | 'invites' | 'moderation' | 'roles';
    /** Told when the owner picks a sub-tab, so Back and the phone top bar follow it. */
    onSubTabChange?: (sub: 'directory' | 'invites' | 'moderation' | 'roles') => void;
    /** Who is signed in to /settings — decides whether Owners & admins offers its add/remove controls. */
    rolesViewer?: RolesViewer;
}

export function PeopleSafetySection({
    activeNode,
    nodeData,
    nodeDataLoading,
    onRefresh,
    onFreezeUser,
    onPruneUser,
    onPruneBranch,
    onUpdateTier,
    onToggleVoucher,
    onToggleOperator,
    onGrantNodeRole,
    onRevokeNodeRole,
    initialSubTab = 'directory',
    onSubTabChange,
    rolesViewer = { kind: 'password' },
}: PeopleSafetySectionProps) {
    const [subTab, setSubTab] = useSectionSubTab<'directory' | 'invites' | 'moderation' | 'roles'>(initialSubTab, onSubTabChange);
    const [directoryView, setDirectoryView] = useState<'roster' | 'tree'>('roster');
    const [selectedThreat, setSelectedThreat] = useState<ThreatItem | null>(null);
    const [bulkDeleteDays, setBulkDeleteDays] = useState(30);
    const [reportFilter, setReportFilter] = useState<'open' | 'dismissed' | 'actioned' | 'all'>('open');
    const [fetchedReports, setFetchedReports] = useState<NodeReport[] | null>(null);
    const [pendingReportsCount, setPendingReportsCount] = useState<number | null>(null);
    const [reportsLoading, setReportsLoading] = useState(false);
    const [dismissedReportIds, setDismissedReportIds] = useState<Set<string>>(new Set());
    const [actionedReportIds, setActionedReportIds] = useState<Set<string>>(new Set());

    const loadReports = async () => {
        if (!activeNode?.url) return;
        setReportsLoading(true);
        try {
            const res = await fetchReports(
                activeNode.url,
                reportFilter,
                50,
                0,
                activeNode.adminPassword,
                getTfaSessionToken(activeNode.id)
            );
            setFetchedReports(res.reports);
            setPendingReportsCount(res.pendingCount);
        } catch {
            // Silently fall back to nodeData?.reports
        } finally {
            setReportsLoading(false);
        }
    };

    // Reloads the node data and, when the reports came from /reports, that list and its open count too.
    const refreshReports = () => {
        onRefresh();
        if (fetchedReports !== null) loadReports();
    };

    // The local handled-sets only bridge the gap until the server's list arrives; after that its
    // `outcome` wins.
    useEffect(() => {
        setDismissedReportIds(new Set());
        setActionedReportIds(new Set());
    }, [nodeData?.reports, fetchedReports]);

    useEffect(() => {
        if (subTab === 'moderation' && nodeData?.reports === undefined) {
            loadReports();
        }
    }, [subTab, reportFilter, activeNode?.url, activeNode?.id, nodeData?.reports]);

    const handlePruneBranch = onPruneBranch || (async (pubkey: string) => {
        await pruneInviteBranch(activeNode.url, pubkey, activeNode.adminPassword, getTfaSessionToken(activeNode.id));
        onRefresh();
    });
    const [bulkDeleting, setBulkDeleting] = useState(false);
    const [bulkDeleteResult, setBulkDeleteResult] = useState<string | null>(null);
    const [removingReportId, setRemovingReportId] = useState<string | null>(null);
    const [pulseRemoveError, setPulseRemoveError] = useState<string | null>(null);

    const handleRemovePulseItem = async (reportId: string) => {
        if (!confirm('Remove this item from the Pulse? The member is not suspended.')) return;
        setRemovingReportId(reportId);
        setPulseRemoveError(null);
        try {
            await removeReportedPulseItem(activeNode.url, reportId, activeNode.adminPassword, getTfaSessionToken(activeNode.id));
            setActionedReportIds((prev) => new Set(prev).add(String(reportId)));
            refreshReports();
        } catch (e: any) {
            setPulseRemoveError(e?.message || 'Failed to remove the item');
        } finally {
            setRemovingReportId(null);
        }
    };

    const rawReports: NodeReport[] = Array.isArray(nodeData?.reports) ? nodeData.reports : [];
    const members = Array.isArray(nodeData?.members) ? nodeData.members : [];

    const getOutcome = (r: any): 'open' | 'dismissed' | 'actioned' => {
        const id = String(r.id);
        if (dismissedReportIds.has(id)) return 'dismissed';
        if (actionedReportIds.has(id)) return 'actioned';
        if (r.outcome === 'open' || r.outcome === 'dismissed' || r.outcome === 'actioned') return r.outcome;
        if (r.status === 'reviewed') return 'dismissed';
        if (r.status === 'actioned') return 'actioned';
        return 'open';
    };

    const reportsToDisplay: NodeReport[] = (fetchedReports !== null ? fetchedReports : rawReports).filter(
        (r) => reportFilter === 'all' || getOutcome(r) === reportFilter
    );

    const openReportsCount = pendingReportsCount !== null
        ? pendingReportsCount
        : rawReports.filter((r) => getOutcome(r) === 'open').length;

    const handleBulkDeletePosts = async () => {
        if (!confirm(`Permanently delete all posts older than ${bulkDeleteDays} days?`)) return;
        setBulkDeleting(true);
        setBulkDeleteResult(null);
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/posts/bulk-delete');
            const cutoffMs = Date.now() - bulkDeleteDays * 24 * 60 * 60 * 1000;
            const posts = (nodeData?.posts || []) as Array<{ id: string; createdAt?: string | number }>;
            const stalePostIds = posts
                .filter((p) => p.createdAt && new Date(p.createdAt).getTime() < cutoffMs)
                .map((p) => p.id);

            if (stalePostIds.length === 0) {
                setBulkDeleteResult(`No posts older than ${bulkDeleteDays} days found.`);
                setBulkDeleting(false);
                return;
            }

            const res = await fetch(url, {
                method: 'POST',
                headers: buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
                body: JSON.stringify({ postIds: stalePostIds }),
            });
            const data = await res.json();
            if (res.ok) {
                const count = data.deleted ?? data.deletedCount ?? stalePostIds.length;
                setBulkDeleteResult(`Deleted ${count} post(s).`);
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
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 border-b border-nature-800 pb-4">
                <div>
                    <h2 className="text-xl font-black text-white m-0 tracking-tight flex items-center gap-2.5">
                        <span>👥</span>
                        <span>People &amp; Safety</span>
                        <HelpLink screen={`people/${subTab}`} />
                    </h2>
                    <p className="text-xs text-nature-400 m-0 mt-1">
                        Member directory, trust tiers, invites, QR cards, report triage, and who runs the node
                    </p>
                </div>

                <SubTabStrip wrap={true}>
                    <button
                        onClick={() => setSubTab('directory')}
                        data-subtab="directory"
                        aria-current={subTab === 'directory' ? 'page' : undefined}
                        className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all shrink-0 whitespace-nowrap min-h-[48px] lg:min-h-0 lg:shrink lg:whitespace-normal ${
                            subTab === 'directory'
                                ? 'bg-terra-500/20 text-terra-300 border border-terra-500/40 shadow-sm'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        Members ({members.length})
                    </button>
                    <button
                        onClick={() => setSubTab('invites')}
                        data-subtab="invites"
                        aria-current={subTab === 'invites' ? 'page' : undefined}
                        className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all shrink-0 whitespace-nowrap min-h-[48px] lg:min-h-0 lg:shrink lg:whitespace-normal ${
                            subTab === 'invites'
                                ? 'bg-terra-500/20 text-terra-300 border border-terra-500/40 shadow-sm'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        Invites &amp; QR
                    </button>
                    <button
                        onClick={() => setSubTab('moderation')}
                        data-subtab="moderation"
                        aria-current={subTab === 'moderation' ? 'page' : undefined}
                        className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 shrink-0 whitespace-nowrap min-h-[48px] lg:min-h-0 lg:shrink lg:whitespace-normal ${
                            subTab === 'moderation'
                                ? 'bg-terra-500/20 text-terra-300 border border-terra-500/40 shadow-sm'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        <span>Triage &amp; Moderation</span>
                        {openReportsCount > 0 && (
                            <span className="px-1.5 py-0.2 rounded-full bg-amber-500 text-black text-[10px] font-bold">
                                {openReportsCount}
                            </span>
                        )}
                    </button>
                    <button
                        onClick={() => setSubTab('roles')}
                        data-subtab="roles"
                        aria-current={subTab === 'roles' ? 'page' : undefined}
                        className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all shrink-0 whitespace-nowrap min-h-[48px] lg:min-h-0 lg:shrink lg:whitespace-normal ${
                            subTab === 'roles'
                                ? 'bg-terra-500/20 text-terra-300 border border-terra-500/40 shadow-sm'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        Owners &amp; admins
                    </button>
                </SubTabStrip>
            </div>

            {/* Sub-tab content */}
            {subTab === 'directory' && (
                <div className="space-y-4">
                    <div className="flex items-center justify-between gap-3 bg-nature-950/70 p-2 rounded-xl border border-nature-800">
                        <div className="flex items-center gap-1.5">
                            <button
                                type="button"
                                id="view-roster-btn"
                                onClick={() => setDirectoryView('roster')}
                                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                                    directoryView === 'roster'
                                        ? 'bg-terra-500/20 text-terra-300 border border-terra-500/40 shadow-sm'
                                        : 'text-nature-400 hover:text-white border border-transparent'
                                }`}
                            >
                                <span>📋</span>
                                <span>Member Roster</span>
                            </button>
                            <button
                                type="button"
                                id="view-tree-btn"
                                onClick={() => setDirectoryView('tree')}
                                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                                    directoryView === 'tree'
                                        ? 'bg-terra-500/20 text-terra-300 border border-terra-500/40 shadow-sm'
                                        : 'text-nature-400 hover:text-white border border-transparent'
                                }`}
                            >
                                <span>🌳</span>
                                <span>Ancestry Tree</span>
                            </button>
                        </div>
                    </div>

                    {directoryView === 'roster' ? (
                        <MembersModule
                            nodeData={nodeData}
                            nodeDataLoading={nodeDataLoading}
                            activeNodeUrl={activeNode.url}
                            adminPassword={activeNode.adminPassword}
                            tfaToken={activeNode ? getTfaSessionToken(activeNode.id) : undefined}
                            onRefresh={onRefresh}
                            onFreezeUser={onFreezeUser}
                            onPruneUser={onPruneUser}
                            onPruneBranch={handlePruneBranch}
                            onUpdateTier={onUpdateTier}
                            onToggleVoucher={onToggleVoucher}
                            onToggleOperator={onToggleOperator}
                            onGrantNodeRole={onGrantNodeRole}
                            onRevokeNodeRole={onRevokeNodeRole}
                        />
                    ) : (
                        <SectionErrorBoundary sectionName="Ancestry Tree" resetKey={activeNode.id}>
                            <AncestryTreePanel
                                nodeData={nodeData}
                                nodeDataLoading={nodeDataLoading}
                                activeNode={activeNode}
                                onRefresh={onRefresh}
                                onPruneBranch={handlePruneBranch}
                            />
                        </SectionErrorBoundary>
                    )}
                </div>
            )}

            {subTab === 'invites' && (
                <InvitesModule activeNode={activeNode} />
            )}

            {subTab === 'roles' && (
                <SectionErrorBoundary sectionName="Owners & admins" resetKey={activeNode.id}>
                    <NodeRolesPanel activeNode={activeNode} members={members} viewer={rolesViewer} onChanged={onRefresh} />
                </SectionErrorBoundary>
            )}

            {subTab === 'moderation' && (
                <div className="space-y-6">
                    {/* Pending Reports List */}
                    <div className="bg-nature-900/80 border border-nature-800 rounded-2xl p-6 shadow-xl space-y-4">
                        <div className="flex flex-wrap lg:flex-nowrap items-center justify-between gap-3 lg:gap-0 border-b border-nature-800 pb-3">
                            <div className="min-w-0">
                                <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                                    <span>⚠️</span>
                                    <span>Community Report Triage</span>
                                </h3>
                                <p className="text-xs text-nature-400 m-0 mt-0.5">
                                    Member-reported abuse, harassment, or invalid listings requiring operator action
                                </p>
                            </div>
                            <button
                                onClick={() => {
                                    onRefresh();
                                    loadReports();
                                }}
                                className="px-3 py-1.5 rounded-lg bg-nature-800 hover:bg-nature-700 text-xs text-white font-bold transition-all min-h-[48px] lg:min-h-0"
                            >
                                Refresh
                            </button>
                        </div>

                        {/* Filter Tabs for Reports */}
                        <div className="flex flex-wrap lg:flex-nowrap items-center gap-2 pt-1 pb-1">
                            <button
                                onClick={() => setReportFilter('open')}
                                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition min-h-[48px] lg:min-h-0 ${
                                    reportFilter === 'open'
                                        ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm'
                                        : 'text-nature-400 hover:text-white border border-transparent'
                                }`}
                            >
                                Open
                            </button>
                            <button
                                onClick={() => setReportFilter('dismissed')}
                                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition min-h-[48px] lg:min-h-0 ${
                                    reportFilter === 'dismissed'
                                        ? 'bg-nature-700 text-white border border-nature-600 shadow-sm'
                                        : 'text-nature-400 hover:text-white border border-transparent'
                                }`}
                            >
                                Dismissed
                            </button>
                            <button
                                onClick={() => setReportFilter('actioned')}
                                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition min-h-[48px] lg:min-h-0 ${
                                    reportFilter === 'actioned'
                                        ? 'bg-nature-700 text-white border border-nature-600 shadow-sm'
                                        : 'text-nature-400 hover:text-white border border-transparent'
                                }`}
                            >
                                Actioned
                            </button>
                            <button
                                onClick={() => setReportFilter('all')}
                                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition min-h-[48px] lg:min-h-0 ${
                                    reportFilter === 'all'
                                        ? 'bg-nature-700 text-white border border-nature-600 shadow-sm'
                                        : 'text-nature-400 hover:text-white border border-transparent'
                                }`}
                            >
                                All
                            </button>
                        </div>

                        {pulseRemoveError && (
                            <div role="alert" className="text-xs font-semibold text-red-300 bg-red-950/40 border border-red-900/60 rounded-lg px-3 py-2">
                                {pulseRemoveError}
                            </div>
                        )}

                        {reportsToDisplay.length === 0 ? (
                            <div className="py-8 text-center text-sm font-semibold text-emerald-400 bg-emerald-950/20 border border-emerald-900/40 rounded-xl">
                                {reportFilter === 'open'
                                    ? '🟢 No pending reports. The community queue is all clear.'
                                    : `No ${reportFilter} reports found.`}
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {reportsToDisplay.map((report: any, idx: number) => {
                                    const postTitle = report.postTitle || report.title;
                                    const authorCallsign = report.postAuthorCallsign;
                                    const isRemoved = Boolean(report.postRemoved);
                                    const hasPost = Boolean(postTitle || report.postId);

                                    return (
                                        <div
                                            key={report.id || idx}
                                            className="p-4 rounded-xl bg-nature-950 border border-nature-800 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 hover:border-nature-700 transition-colors"
                                        >
                                            <div className="space-y-1.5 min-w-0 break-words flex-1">
                                                <div className="flex flex-wrap lg:flex-nowrap items-center gap-2">
                                                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30">
                                                        {report.severity || 'Report'}
                                                    </span>
                                                    {report.outcome && report.outcome !== 'open' && (
                                                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                                                            report.outcome === 'actioned'
                                                                ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                                                                : 'bg-nature-800 text-nature-300 border border-nature-700'
                                                        }`}>
                                                            {report.outcome}
                                                        </span>
                                                    )}
                                                    <span className="text-xs font-mono text-nature-300">
                                                        {(() => {
                                                            const target = typeof report.targetPubkey === 'string'
                                                                ? report.targetPubkey
                                                                : (typeof report.target_pubkey === 'string'
                                                                    ? report.target_pubkey
                                                                    : (report.targetPubkey && typeof report.targetPubkey.publicKey === 'string'
                                                                        ? report.targetPubkey.publicKey
                                                                        : ''));
                                                            return `Target: ${target ? `${target.slice(0, 16)}...` : 'Unknown'}`;
                                                        })()}
                                                    </span>
                                                </div>

                                                {hasPost && (
                                                    <div className="text-xs flex items-center gap-2 flex-wrap text-nature-300 bg-nature-900/60 px-2.5 py-1 rounded-lg border border-nature-800/80">
                                                        <span className="text-nature-400">Post:</span>
                                                        <span className="font-semibold text-white">{postTitle || 'Untitled Post'}</span>
                                                        {authorCallsign && (
                                                            <span className="text-nature-400">
                                                                by <span className="text-terra-300 font-medium">@{authorCallsign.replace(/^@/, '')}</span>
                                                            </span>
                                                        )}
                                                        {isRemoved && (
                                                            <span className="px-1.5 py-0.2 rounded text-[10px] font-bold bg-zinc-800 text-zinc-400 border border-zinc-700">
                                                                Removed
                                                            </span>
                                                        )}
                                                    </div>
                                                )}

                                                <p className="text-xs text-white m-0">
                                                    {report.reason || report.description || 'No reason provided'}
                                                </p>
                                                {report.pulseItem && typeof report.pulseItem === 'object' && (
                                                    <div className="text-xs text-nature-300 flex flex-wrap items-center gap-2" data-testid="pulse-report-item">
                                                        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-nature-800 text-nature-200 border border-nature-700">
                                                            Pulse · {String(report.pulseItem.platform || 'unknown')}
                                                        </span>
                                                        {report.pulseItem.removed ? (
                                                            <span className="text-nature-400 italic">Removed from the Pulse</span>
                                                        ) : typeof report.pulseItem.url === 'string' && /^https?:\/\//i.test(report.pulseItem.url) ? (
                                                            <a
                                                                href={report.pulseItem.url}
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                                className="inline-flex items-center min-h-[48px] lg:min-h-0 min-w-0 text-terra-300 underline break-all"
                                                            >
                                                                {report.pulseItem.title || report.pulseItem.url}
                                                            </a>
                                                        ) : (
                                                            <span>{report.pulseItem.title || 'Untitled item'}</span>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                            <div className="flex items-center gap-2 self-end sm:self-auto">
                                                {report.pulseItem && typeof report.pulseItem === 'object' && !report.pulseItem.removed && report.id && (
                                                    <button
                                                        onClick={() => handleRemovePulseItem(String(report.id))}
                                                        disabled={removingReportId === report.id}
                                                        className="px-3 py-1.5 rounded-lg bg-red-900/80 hover:bg-red-800 border border-red-700 text-xs font-bold text-white transition-all disabled:opacity-50 min-h-[48px] lg:min-h-0"
                                                    >
                                                        {removingReportId === report.id ? 'Removing...' : 'Remove from the Pulse'}
                                                    </button>
                                                )}
                                                <button
                                                    onClick={() => setSelectedThreat(report)}
                                                    className="px-3 py-1.5 rounded-lg bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all shadow-sm min-h-[48px] lg:min-h-0"
                                                >
                                                    Inspect &amp; Action
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}
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

                    {/* Individual Post Search, Filtering & Deletion Panel */}
                    <SectionErrorBoundary sectionName="Post Moderation" resetKey={activeNode.id}>
                        <PostModerationPanel
                            posts={nodeData?.posts as any}
                            activeNode={activeNode}
                            onRefresh={onRefresh}
                        />
                    </SectionErrorBoundary>
                </div>
            )}

            {/* Threat Review Modal */}
            {selectedThreat && (
                <ThreatReviewModal
                    threat={selectedThreat}
                    members={nodeData?.members as any}
                    onClose={() => setSelectedThreat(null)}
                    onDismiss={() => {
                        // Only reached after onDismissReport succeeded; the server call marks it handled.
                        setSelectedThreat(null);
                    }}
                    onDismissReport={async (threat) => {
                        await dismissNodeReport(activeNode.url, String(threat.id), activeNode.adminPassword, getTfaSessionToken(activeNode.id));
                        if (threat?.id) {
                            setDismissedReportIds((prev) => new Set(prev).add(String(threat.id)));
                        }
                        refreshReports();
                    }}
                    onFreezePubkeys={async (pks) => {
                        // Freezing is not an outcome for the report: it stays open until dismissed or actioned.
                        // A failure throws back to the modal, which shows it and stays open.
                        try {
                            for (const pk of pks) {
                                await onFreezeUser(pk, true);
                            }
                        } finally {
                            refreshReports();
                        }
                    }}
                />
            )}
        </div>
    );
}
