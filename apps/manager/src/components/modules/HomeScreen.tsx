import React, { useState, useEffect, useMemo } from 'react';
import { HelpLink } from '../manual/Manual';
import type { DiagnosticsResponse, NodeDataPayload, MemberItem, NodeReport } from '../../lib/node-client';
import { nodeCredential, getTfaSessionToken } from '../../lib/node-client';
import { FEEDBACK_LIVE } from '@beanpool/core';
import { SuggestChangePanel } from './SuggestChangePanel';
import { WebVisitsCard } from './WebVisitsCard';
import { AppVersionsCard } from './AppVersionsCard';
import type { NodeProfile } from '../../lib/profiles';
import { type Shape, fetchCommunityShape } from '../../lib/community-shape';

/** The Alerts card (AlertsPanel, under Backups & Restore): where each of the server's alerts is listed and marked seen. */
export const SERVER_ALERTS_ANCHOR = 'server-alerts';

type HomeTab = 'shape' | 'people' | 'economy' | 'bulletin' | 'appliance';

interface HomeScreenProps {
    communityName: string;
    publicDomain: string;
    version: string;
    diag: DiagnosticsResponse | null;
    nodeData: NodeDataPayload | null;
    /** The node's data (members, reports, trades) is on its way: its figures say so, never 0. */
    nodeDataLoading?: boolean;
    /** Why that data last failed to load (refused, failed, timed out): its figures say they couldn't load, with a retry. */
    nodeDataError?: string | null;
    /** Why the diagnostics last failed to load (connections, storage, the server's alerts). */
    diagError?: string | null;
    onRetryNodeData?: () => void;
    onRetryDiag?: () => void;
    /** `anchor`: a card inside the section to bring into view (SERVER_ALERTS_ANCHOR). */
    onNavigate: (tab: HomeTab, subTab?: string, anchor?: string) => void;
    onInviteMember: () => void;
    onCreateEnterprise: () => void;
    onDownloadBackup: () => Promise<void>;
    onRunLedgerAudit: () => Promise<void>;
    auditState: { running: boolean; result: { ok: boolean; drift: number | null; sumBalances?: number | null } | null };
    onStartColdStartWizard?: () => void;
    onAcknowledgeShutdown?: () => Promise<void>;
    /** An owner's "this standby is gone for good": the node stops watching it (its next report watches it again). */
    onForgetStandby?: (id: string) => Promise<void>;
    /** The node this Home is for: its web app visits card reads it. Without one the card is not shown. */
    activeNode?: NodeProfile;
    /** How this community works shape settings (optional, will fetch from activeNode if omitted). */
    shape?: Shape | null;
}

export function HomeScreen({
    communityName,
    publicDomain,
    version,
    diag,
    nodeData,
    nodeDataLoading = false,
    nodeDataError = null,
    diagError = null,
    onRetryNodeData,
    onRetryDiag,
    onNavigate,
    onInviteMember,
    onCreateEnterprise,
    onDownloadBackup,
    onRunLedgerAudit,
    auditState,
    onStartColdStartWizard,
    onAcknowledgeShutdown,
    onForgetStandby,
    activeNode,
    shape,
}: HomeScreenProps) {
    const [shutdownDismissed, setShutdownDismissed] = useState(false);
    const [communityShape, setCommunityShape] = useState<Shape | null>(shape ?? null);

    useEffect(() => {
        if (shape !== undefined) {
            setCommunityShape(shape);
            return;
        }
        let mounted = true;
        if (activeNode) {
            fetchCommunityShape(activeNode.url, nodeCredential(activeNode), getTfaSessionToken(activeNode.id))
                .then((data) => {
                    if (mounted) setCommunityShape(data);
                })
                .catch(() => {});
        }
        return () => {
            mounted = false;
        };
    }, [shape, activeNode?.id, activeNode?.url]);

    const shapeCardText = useMemo(() => {
        if (!communityShape) return null;
        const s = communityShape.settings;
        const joinText =
            s.join.value === 'members'
                ? 'any member invites'
                : s.join.value === 'admins'
                ? 'only admins invite'
                : s.join.value === 'paused'
                ? 'paused'
                : 'open door';
        const beansText = s.beans.value ? 'Beans on' : 'Beans off';
        const votesText = s.decisions.value ? 'votes on' : 'votes off';
        const knocksText = s.knocks.value ? 'requests to join on' : 'requests to join off';
        return `🧭 How this community works · ${joinText} · ${beansText} · ${votesText} · ${knocksText} · Change ›`;
    }, [communityShape]);

    useEffect(() => {
        setShutdownDismissed(false);
    }, [diag?.shutdownStatus?.powerLossTimestamp, diag?.shutdownStatus?.checkedAt, communityName]);

    // Every figure below is the node's, or null when the data behind it didn't arrive: Home then says it couldn't load (or
    // is loading), never 0. A 0 that meant "not loaded" said 0 members on a 34-member community (Marty, 19 Oct).
    const dataState: 'loaded' | 'loading' | 'failed' = nodeData ? 'loaded' : (nodeDataLoading || !nodeDataError ? 'loading' : 'failed');
    const diagState: 'loaded' | 'loading' | 'failed' = diag ? 'loaded' : (diagError ? 'failed' : 'loading');

    // Action required counts
    const members = Array.isArray(nodeData?.members) ? nodeData.members : null;
    const pendingReportsCount = typeof nodeData?.reportCount === 'number'
        ? nodeData.reportCount
        : (Array.isArray(nodeData?.reports)
            ? nodeData.reports.filter((r: NodeReport) => (r.outcome ? r.outcome === 'open' : (r.status === 'pending' || !r.status))).length
            : null);

    const membersCount = members ? members.filter((m: MemberItem) => m && !m.isTreasury).length : null;
    const enterprisesCount = Array.isArray(nodeData?.enterprises)
        ? nodeData.enterprises.length
        : (members ? members.filter((m: MemberItem) => m && m.isTreasury).length : null);

    const circulationVolume = (() => {
        if (typeof nodeData?.tradeVolume === 'number') {
            return nodeData.tradeVolume.toFixed(1);
        }
        if (typeof nodeData?.circulation === 'number') {
            return nodeData.circulation.toFixed(1);
        }
        // The community's completed trade volume, each trade once: member stats carry no member's trades (queue item 29).
        if (typeof nodeData?.tradeTotals?.volume === 'number') {
            return nodeData.tradeTotals.volume.toFixed(1);
        }
        return null;
    })();

    // The Commons pot, from the node's data (routes/admin.ts /admin/data). Not the ledger audit's sum of balances: that is
    // the conservation baseline, which is no pool at all.
    const commonsBalance = typeof nodeData?.commonsBalance === 'number' && Number.isFinite(nodeData.commonsBalance)
        ? nodeData.commonsBalance.toFixed(1)
        : null;

    // Disk/storage usage percentage: prefer real diskHealth if provided by server
    const storagePercent = !diag ? null : typeof diag.diskHealth?.usedPercent === 'number'
        ? diag.diskHealth.usedPercent
        : (() => {
            const dbBytes = diag.dbSizeBytes || 0;
            const walBytes = diag.walSizeBytes || 0;
            const totalStorageMb = Math.round((dbBytes + walBytes) / (1024 * 1024) * 10) / 10;
            return Math.min(100, Math.round((totalStorageMb / 500) * 100));
        })();

    // The server's alerts, exactly as the phone's "This server has alerts: N" counts them (the node's diagnostics): null to
    // anyone but an owner, as on the phone; absent on a server from before them, or when the node couldn't read them.
    const serverAlerts = diag?.serverAlerts;
    const alertsRead = Boolean(serverAlerts && Array.isArray(serverAlerts.items));
    const alertsUnread = Boolean(diag) && serverAlerts !== null && !alertsRead;

    // Unclean shutdown status
    const shutdownStatus = diag?.shutdownStatus;
    const showShutdownCard = Boolean(
        shutdownStatus &&
        shutdownStatus.uncleanShutdown &&
        !shutdownStatus.acknowledged &&
        !shutdownDismissed
    );

    // The standby's incident (the node's standby watch; absent on a server before it, null to anyone but an owner)
    const standbyIncident = diag?.standbyHealth?.incident ?? null;
    const unhealthyStandbys = (diag?.standbyHealth?.standbys ?? []).filter((s) => !s.healthy);
    // Off-box backups that need the owners (failing, late, a destination that can't be used, or none sent for want of a
    // recovery code): owners only, absent on a server from before them.
    const offboxProblems = diag?.offboxBackups?.problems ?? [];

    // Action items
    const actionItems: { key: string; icon: string; text: string; tab: HomeTab; sub?: string; anchor?: string }[] = [];
    // Each of the server's alerts in the node's words, linked to the Alerts card where it is listed and marked seen.
    for (const a of alertsRead ? serverAlerts!.items : []) {
        actionItems.push({
            key: `alert-${a.key}`,
            icon: a.priority >= 5 ? '🚨' : a.priority >= 4 ? '⚠️' : '🔔',
            text: a.detail || a.title,
            tab: 'appliance',
            sub: 'backups',
            anchor: SERVER_ALERTS_ANCHOR,
        });
    }
    if (alertsUnread) {
        actionItems.push({
            key: 'alerts-unread',
            icon: '🔔',
            text: "This server's alerts couldn't be read here: open Alerts to see them",
            tab: 'appliance',
            sub: 'backups',
            anchor: SERVER_ALERTS_ANCHOR,
        });
    }
    if (pendingReportsCount !== null && pendingReportsCount > 0) {
        actionItems.push({
            key: 'reports',
            icon: '⚠️',
            text: `${pendingReportsCount} report${pendingReportsCount > 1 ? 's' : ''} pending`,
            tab: 'people',
            sub: 'moderation',
        });
    }

    const pendingDisputesCount = typeof nodeData?.escrowDisputesCount === 'number'
        ? nodeData.escrowDisputesCount
        : null;
    if (pendingDisputesCount !== null && pendingDisputesCount > 0) {
        actionItems.push({
            key: 'disputes',
            icon: '⚖️',
            text: `${pendingDisputesCount} escrow dispute${pendingDisputesCount > 1 ? 's' : ''} pending`,
            tab: 'economy',
            sub: 'disputes',
        });
    }

    if (storagePercent !== null && storagePercent >= 80) {
        actionItems.push({
            key: 'storage',
            icon: '💾',
            text: `Storage ${storagePercent}%`,
            tab: 'appliance',
            sub: 'diagnostics',
        });
    }

    // What Action Required could not look at yet: "All clear" only when nothing is left here and nothing is listed.
    const fromData = [pendingReportsCount === null && 'reports', pendingDisputesCount === null && 'escrow disputes'].filter(Boolean) as string[];
    const fromDiag = diag ? [] : ['storage', "the server's alerts"];
    const unchecked = [...fromData, ...fromDiag];
    // Data that arrived without these fields (an older server) is no load to wait for: it is unchecked, and said so.
    const uncheckedLoading = (fromData.length > 0 && dataState === 'loading') || (fromDiag.length > 0 && diagState === 'loading');
    const retryChecks = () => {
        if (fromData.length > 0 && dataState !== 'loading') onRetryNodeData?.();
        if (fromDiag.length > 0 && diagState === 'failed') onRetryDiag?.();
    };
    const uncheckedWhy = [fromData.length > 0 && dataState === 'failed' && nodeDataError, fromDiag.length > 0 && diagState === 'failed' && diagError]
        .filter(Boolean).join('; ');

    // The four figures: each the node's value, or null (loading, or couldn't load).
    const missingFigures = [
        membersCount === null && 'members',
        commonsBalance === null && 'the Commons pool',
        enterprisesCount === null && 'enterprises',
        circulationVolume === null && 'circulation',
    ].filter(Boolean) as string[];
    const figuresLoading = missingFigures.length > 0 && dataState === 'loading';

    const driftText = auditState.result
        ? `Ledger ${auditState.result.ok ? 'balanced' : 'drift detected'} (${Number.isFinite(auditState.result.drift) ? auditState.result.drift : 'not a number'} drift)`
        : 'Ledger not audited yet';
    const connections = typeof diag?.activeWsConnections === 'number' ? diag.activeWsConnections : null;

    return (
        <div className="space-y-6 font-sans animate-fade-in">
            {/* 1. Header — community name, public domain, appliance status */}
            <div className="bg-nature-900/80 border border-nature-800 rounded-3xl p-6 shadow-xl backdrop-blur-md">
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                    <div className="min-w-0">
                        <div className="flex flex-wrap lg:flex-nowrap items-center gap-x-2 gap-y-1 mb-1">
                            <h1 className="text-2xl font-black text-white m-0 tracking-tight break-words min-w-0">
                                {communityName || 'Sovereign Community'}
                            </h1>
                            <HelpLink screen="home" />
                            <span className="px-2.5 py-0.5 rounded-full bg-bp-chip-need-tint border border-terra-500/30 text-bp-chip-need-ink text-xs font-semibold max-w-full truncate lg:overflow-visible lg:shrink-0">
                                {publicDomain || 'local'}
                            </span>
                        </div>
                        <p className="text-xs text-nature-400 m-0 font-mono flex items-center gap-2 flex-wrap">
                            <span className="flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                                <span className="text-emerald-400 font-semibold">Online</span>
                            </span>
                            <span>·</span>
                            <span className="text-nature-300 font-semibold">{driftText}</span>
                            <span>·</span>
                            <span className="text-nature-400">Backed up recently</span>
                            <span>·</span>
                            <span className="text-nature-400 font-mono">v{version || '1.4.2'}</span>
                        </p>
                    </div>

                    {/* Quick status pill: the node's count, or why there is none (never a 0 that wasn't sent) */}
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            data-testid="home-connections"
                            onClick={() => onNavigate('appliance', 'diagnostics')}
                            className="min-h-[44px] px-3.5 py-2 rounded-xl bg-nature-800/80 hover:bg-nature-700 text-xs font-bold text-nature-200 border border-nature-700 transition-all flex items-center gap-2"
                        >
                            <span aria-hidden="true">🔌</span>
                            <span>
                                {connections !== null
                                    ? `${connections} active connection${connections === 1 ? '' : 's'}`
                                    : diagState === 'loading' ? 'Connections loading…' : "Connections couldn't load"}
                            </span>
                        </button>
                        {connections === null && diagState !== 'loading' && onRetryDiag && (
                            <RetryButton onClick={onRetryDiag} label="Retry connections" />
                        )}
                    </div>
                </div>
            </div>

            {/* Unclean Shutdown Diagnostic Card */}
            {showShutdownCard && shutdownStatus && (
                shutdownStatus.ok ? (
                    <div
                        data-testid="unclean-shutdown-reassurance"
                        className="p-5 rounded-2xl bg-emerald-950/60 border-2 border-emerald-500/70 shadow-xl flex flex-col md:flex-row md:items-center md:justify-between gap-4 animate-fade-in"
                    >
                        <div className="flex items-start gap-3.5">
                            <span className="text-2xl" aria-hidden="true">🛡️</span>
                            <div>
                                <div className="flex items-center gap-2">
                                    <span className="px-2 py-0.5 rounded bg-emerald-900/80 text-emerald-300 border border-emerald-600/60 text-[10px] font-bold uppercase tracking-wider">
                                        Power Recovery Reassurance
                                    </span>
                                    <span className="text-xs text-emerald-400 font-mono font-bold">PRAGMA integrity_check: ok</span>
                                </div>
                                <h4 className="text-sm font-black text-white m-0 mt-1">
                                    {shutdownStatus.message || `Recovered from power loss at ${shutdownStatus.powerLossAt || '04:12'}. Database verified, no corruption.`}
                                </h4>
                                <p className="text-xs text-emerald-200/80 m-0 mt-0.5 max-w-2xl">
                                    On boot after an unclean shutdown, SQLite PRAGMA integrity_check verified all database blocks. All member balances, transactions, and ledgers are intact.
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center gap-2 self-end md:self-center shrink-0">
                            <button
                                type="button"
                                onClick={async () => {
                                    setShutdownDismissed(true);
                                    if (onAcknowledgeShutdown) {
                                        await onAcknowledgeShutdown().catch(() => {});
                                    }
                                }}
                                className="px-4 py-2 rounded-xl bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on text-xs font-bold transition-all shadow-md active:scale-95"
                            >
                                Dismiss
                            </button>
                        </div>
                    </div>
                ) : (
                    <div
                        data-testid="unclean-shutdown-alert"
                        role="alert"
                        aria-live="assertive"
                        className="p-6 rounded-2xl bg-red-950/90 border-4 border-red-500 shadow-2xl space-y-3 animate-fade-in text-left"
                    >
                        <div className="flex items-start justify-between gap-4 flex-wrap">
                            <div className="flex items-start gap-3.5">
                                <span className="text-3xl" aria-hidden="true">🚨</span>
                                <div>
                                    <span className="px-2 py-0.5 rounded bg-red-900 text-red-200 border border-red-500 text-[10px] font-bold uppercase tracking-wider">
                                        Critical Alert · Database Corruption Detected
                                    </span>
                                    <h3 className="text-base font-black text-white m-0 mt-1">
                                        {shutdownStatus.message || `Database corruption detected after power loss at ${shutdownStatus.powerLossAt || '04:12'}!`}
                                    </h3>
                                    <p className="text-xs text-red-200 m-0 mt-1 max-w-2xl font-semibold">
                                        The node suffered an unclean stop and PRAGMA integrity_check reported corruption errors. Do NOT accept further transactions until restored from a verified snapshot.
                                    </p>
                                    {shutdownStatus.error && (
                                        <div className="mt-2 p-2.5 rounded bg-black/60 border border-red-500/50 font-mono text-[11px] text-red-300 break-all">
                                            {shutdownStatus.error}
                                        </div>
                                    )}
                                </div>
                            </div>
                            <div className="flex items-center gap-2.5 shrink-0 self-end sm:self-center">
                                <button
                                    type="button"
                                    onClick={() => onNavigate('appliance', 'backups')}
                                    className="px-4 py-2.5 rounded-xl bg-bp-danger-fill hover:bg-bp-danger-hover text-bp-danger-on text-xs font-black transition-all shadow-lg active:scale-95 flex items-center gap-1.5"
                                >
                                    <span>💾</span>
                                    <span>Restore from Backup</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={async () => {
                                        setShutdownDismissed(true);
                                        if (onAcknowledgeShutdown) {
                                            await onAcknowledgeShutdown().catch(() => {});
                                        }
                                    }}
                                    className="px-3.5 py-2.5 rounded-xl bg-nature-800 hover:bg-nature-700 text-nature-300 hover:text-white text-xs font-bold transition-all border border-nature-700"
                                >
                                    Acknowledge
                                </button>
                            </div>
                        </div>
                    </div>
                )
            )}

            {/* The standby needs its owners (owners only: the node sends it to nobody else) */}
            {standbyIncident && (
                <div
                    data-testid="standby-health-banner"
                    role="alert"
                    className="p-5 rounded-2xl bg-amber-950/70 border-2 border-amber-600/70 shadow-xl space-y-3 animate-fade-in text-left"
                    style={{ overflowWrap: 'anywhere' }}
                >
                    <div className="flex items-start gap-3.5">
                        <span className="text-2xl" aria-hidden="true">🛟</span>
                        <div className="min-w-0 space-y-1">
                            <h3 className="text-base font-black text-white m-0">Your standby server needs attention</h3>
                            {standbyIncident.lines.map((l) => <p key={l} className="text-sm text-amber-100 m-0">{l}</p>)}
                            {standbyIncident.whatToDo.map((w) => <p key={w} className="text-xs text-amber-200/80 m-0">{w}</p>)}
                            <p className="text-xs text-amber-200/70 m-0">This stays here until the standby copies this server again, exactly.</p>
                        </div>
                    </div>
                    {onForgetStandby && unhealthyStandbys.length > 0 && (
                        <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 sm:justify-end">
                            {unhealthyStandbys.map((s) => (
                                <button
                                    key={s.id}
                                    type="button"
                                    onClick={async () => { await onForgetStandby(s.id).catch(() => {}); }}
                                    className="min-h-[44px] px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-nature-200 hover:text-white text-xs font-bold transition-all border border-nature-700"
                                >
                                    {s.label} is gone for good: stop watching it
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Backups off the server need the owners (owners only: the node sends it to nobody else) */}
            {offboxProblems.length > 0 && (
                <div
                    data-testid="offbox-health-banner"
                    role="alert"
                    className="p-5 rounded-2xl bg-amber-950/70 border-2 border-amber-600/70 shadow-xl space-y-3 animate-fade-in text-left"
                    style={{ overflowWrap: 'anywhere' }}
                >
                    <div className="flex items-start gap-3.5">
                        <span className="text-2xl" aria-hidden="true">🗄️</span>
                        <div className="min-w-0 space-y-1">
                            <h3 className="text-base font-black text-white m-0">Backups off the server need attention</h3>
                            {offboxProblems.map((l) => <p key={l} className="text-sm text-amber-100 m-0">{l}</p>)}
                        </div>
                    </div>
                    <div className="flex sm:justify-end">
                        <button
                            type="button"
                            onClick={() => onNavigate('appliance', 'backups')}
                            className="min-h-[44px] px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-nature-200 hover:text-white text-xs font-bold transition-all border border-nature-700"
                        >
                            Open Backups &amp; Restore
                        </button>
                    </div>
                </div>
            )}

            {/* 2. Action required — the live list, or All clear only once everything it covers was read */}
            <div className="bg-nature-900/60 border border-nature-800 rounded-2xl p-5 shadow-lg space-y-3" data-testid="home-action-required">
                <h3 className="text-xs font-bold uppercase tracking-wider text-nature-400 m-0 flex items-center gap-2">
                    <span>⚡</span>
                    <span>Action Required</span>
                </h3>
                {alertsRead && serverAlerts!.count > 0 && (
                    // The words the phone's "Needs you" said, so the owner who tapped it sees what it meant.
                    <p className="text-xs font-semibold text-nature-200 m-0">This server has alerts: {serverAlerts!.count}</p>
                )}
                {actionItems.length === 0 && unchecked.length === 0 && (
                    <div className="flex items-center gap-2 text-sm font-semibold text-emerald-400 bg-emerald-950/30 border border-emerald-800/40 px-4 py-3 rounded-xl">
                        <span>🟢</span>
                        <span>All clear — node is running cleanly with no pending actions.</span>
                    </div>
                )}
                {actionItems.length > 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                        {actionItems.map((item) => (
                            <button
                                key={item.key}
                                type="button"
                                onClick={() => onNavigate(item.tab, item.sub, item.anchor)}
                                className="min-h-[44px] flex items-center justify-between gap-2 p-3.5 rounded-xl bg-bp-chip-warn-tint hover:opacity-90 border border-amber-800/50 text-bp-chip-warn-ink text-xs font-bold transition-all text-left group"
                            >
                                <div className="flex items-center gap-2.5 min-w-0">
                                    <span className="text-base shrink-0" aria-hidden="true">{item.icon}</span>
                                    <span className="min-w-0 break-words">{item.text}</span>
                                </div>
                                <span className="text-bp-chip-warn-ink shrink-0 group-hover:translate-x-0.5 transition-transform" aria-hidden="true">→</span>
                            </button>
                        ))}
                    </div>
                )}
                {unchecked.length > 0 && (
                    uncheckedLoading ? (
                        <p className="text-xs text-nature-400 m-0" role="status">Checking {listInWords(unchecked)}…</p>
                    ) : (
                        <div className="flex flex-wrap items-center gap-2" role="status">
                            <p className="text-xs text-nature-300 m-0 min-w-0 break-words flex-1">
                                Couldn't check {listInWords(unchecked)}{uncheckedWhy ? ` (${uncheckedWhy})` : ': this server doesn\'t send them yet, so update it'}.
                            </p>
                            {(onRetryNodeData || onRetryDiag) && <RetryButton onClick={retryChecks} label="Retry the checks" />}
                        </div>
                    )
                )}
            </div>

            {/* How this community works card */}
            {shapeCardText && (
                <button
                    type="button"
                    data-testid="home-community-shape-card"
                    onClick={() => onNavigate('shape')}
                    className="w-full p-4 rounded-2xl bg-nature-900/70 hover:bg-nature-900 border border-nature-800 hover:border-nature-700 cursor-pointer transition-all shadow-md text-left flex items-center justify-between gap-3 text-xs text-nature-300 hover:text-white"
                >
                    <span className="truncate">{shapeCardText}</span>
                </button>
            )}

            {/* 3. Four cards — Members · Commons pool · Shared enterprises · Circulation this week */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {/* Members Card */}
                <button
                    type="button"
                    data-testid="home-figure-members"
                    onClick={() => onNavigate('people')}
                    className="p-5 rounded-2xl bg-nature-900/70 hover:bg-nature-900 border border-nature-800 hover:border-nature-700 cursor-pointer transition-all shadow-md group text-left w-full focus:outline-none focus:ring-2 focus:ring-terra-500"
                >
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-bold text-nature-400 uppercase tracking-wider">Members</span>
                        <span className="text-lg" aria-hidden="true">👥</span>
                    </div>
                    <FigureValue value={membersCount === null ? null : String(membersCount)} loading={figuresLoading} />
                    <p className="text-xs text-nature-400 m-0">
                        {membersCount === null ? 'Active members' : membersCount === 1 ? '1 active sovereign member' : `${membersCount} active sovereign members`}
                    </p>
                </button>

                {/* Commons Pool Card */}
                <button
                    type="button"
                    data-testid="home-figure-pool"
                    onClick={() => onNavigate('economy')}
                    className="p-5 rounded-2xl bg-nature-900/70 hover:bg-nature-900 border border-nature-800 hover:border-nature-700 cursor-pointer transition-all shadow-md group text-left w-full focus:outline-none focus:ring-2 focus:ring-terra-500"
                >
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-bold text-nature-400 uppercase tracking-wider">Commons Pool</span>
                        <span className="text-lg" aria-hidden="true">🏛️</span>
                    </div>
                    <FigureValue value={commonsBalance} unit="beans" loading={figuresLoading} />
                    {/* The ledger's state only from an audit run here: nothing claims a balance no one checked. */}
                    <p className={`text-xs m-0 font-medium ${auditState.result ? (auditState.result.ok ? 'text-bp-ink-success' : 'text-bp-ink-warning') : 'text-nature-400'}`}>
                        {auditState.result ? (auditState.result.ok ? '✓ Ledger balanced' : 'Ledger drift detected') : 'Ledger not audited yet'}
                    </p>
                </button>

                {/* Shared Enterprises Card */}
                <button
                    type="button"
                    data-testid="home-figure-enterprises"
                    onClick={() => onNavigate('economy')}
                    className="p-5 rounded-2xl bg-nature-900/70 hover:bg-nature-900 border border-nature-800 hover:border-nature-700 cursor-pointer transition-all shadow-md group text-left w-full focus:outline-none focus:ring-2 focus:ring-terra-500"
                >
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-bold text-nature-400 uppercase tracking-wider">Shared Enterprises</span>
                        <span className="text-lg" aria-hidden="true">🌾</span>
                    </div>
                    <FigureValue value={enterprisesCount === null ? null : String(enterprisesCount)} loading={figuresLoading} />
                    <p className="text-xs text-nature-400 m-0">
                        Community projects &amp; co-ops
                    </p>
                </button>

                {/* Circulation Card */}
                <button
                    type="button"
                    data-testid="home-figure-circulation"
                    onClick={() => onNavigate('appliance', 'diagnostics')}
                    className="p-5 rounded-2xl bg-nature-900/70 hover:bg-nature-900 border border-nature-800 hover:border-nature-700 cursor-pointer transition-all shadow-md group text-left w-full focus:outline-none focus:ring-2 focus:ring-terra-500"
                >
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-bold text-nature-400 uppercase tracking-wider">Circulation</span>
                        <span className="text-lg" aria-hidden="true">🔄</span>
                    </div>
                    <FigureValue value={circulationVolume} unit="beans" loading={figuresLoading} />
                    {/* The node's figure is every completed trade's Beans, ever (state-engine getTradeTotals), not a week's. */}
                    <p className="text-xs text-nature-400 m-0">
                        Completed trades, all time
                    </p>
                </button>
            </div>

            {missingFigures.length > 0 && !figuresLoading && (
                <div className="flex flex-wrap items-center gap-2 -mt-2" role="status" data-testid="home-figures-unloaded">
                    <p className="text-xs text-nature-300 m-0 min-w-0 break-words flex-1">
                        {capitalised(listInWords(missingFigures))} couldn't load
                        {dataState === 'failed' && nodeDataError ? ` (${nodeDataError})` : dataState === 'loaded' ? ': this server doesn\'t send them yet, so update it' : ''}.
                    </p>
                    {onRetryNodeData && <RetryButton onClick={onRetryNodeData} label="Retry the figures" />}
                </div>
            )}

            {/* Web app visits a day, counted by the node itself */}
            {activeNode && <WebVisitsCard node={activeNode} />}

            {/* The phone app's versions and floors: whom raising a floor would stop */}
            {activeNode && <AppVersionsCard node={activeNode} />}

            {/* 4. Quick actions — Invite a member · Create an enterprise · Run ledger audit · Download backup */}
            <div className="bg-nature-900/60 border border-nature-800 rounded-2xl p-6 shadow-lg">
                <h3 className="text-xs font-bold uppercase tracking-wider text-nature-400 mb-4 flex items-center gap-2">
                    <span>⚡</span>
                    <span>Quick Actions</span>
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
                    <button
                        onClick={onInviteMember}
                        className="p-4 rounded-xl bg-nature-800 hover:bg-nature-700/90 active:scale-98 border border-nature-700 text-left transition-all group flex flex-col justify-between"
                    >
                        <span className="text-2xl mb-2">🎫</span>
                        <div>
                            <div className="text-sm font-bold text-white group-hover:text-bp-ink-terra transition-colors">
                                Invite a Member
                            </div>
                            <div className="text-xs text-nature-400 mt-0.5">
                                Generate single-use QR invite code
                            </div>
                        </div>
                    </button>

                    <button
                        onClick={onCreateEnterprise}
                        className="p-4 rounded-xl bg-nature-800 hover:bg-nature-700/90 active:scale-98 border border-nature-700 text-left transition-all group flex flex-col justify-between"
                    >
                        <span className="text-2xl mb-2">🌾</span>
                        <div>
                            <div className="text-sm font-bold text-white group-hover:text-bp-ink-terra transition-colors">
                                Create an Enterprise
                            </div>
                            <div className="text-xs text-nature-400 mt-0.5">
                                Food, tools, energy, or shared works
                            </div>
                        </div>
                    </button>

                    <button
                        onClick={onRunLedgerAudit}
                        disabled={auditState.running}
                        className="p-4 rounded-xl bg-nature-800 hover:bg-nature-700/90 active:scale-98 border border-nature-700 text-left transition-all group flex flex-col justify-between disabled:opacity-50"
                    >
                        <span className="text-2xl mb-2">{auditState.running ? '⏳' : '⚖️'}</span>
                        <div>
                            <div className="text-sm font-bold text-white group-hover:text-bp-ink-terra transition-colors">
                                {auditState.running ? 'Auditing...' : 'Run Ledger Audit'}
                            </div>
                            <div className="text-xs text-nature-400 mt-0.5">
                                Verify zero-sum conservation rule
                            </div>
                        </div>
                    </button>

                    <button
                        onClick={onDownloadBackup}
                        className="p-4 rounded-xl bg-nature-800 hover:bg-nature-700/90 active:scale-98 border border-nature-700 text-left transition-all group flex flex-col justify-between"
                    >
                        <span className="text-2xl mb-2">💾</span>
                        <div>
                            <div className="text-sm font-bold text-white group-hover:text-bp-ink-terra transition-colors">
                                Download Backup
                            </div>
                            <div className="text-xs text-nature-400 mt-0.5">
                                Export sovereign SQLite database
                            </div>
                        </div>
                    </button>
                </div>

                {onStartColdStartWizard && (
                    <div className="mt-4 pt-4 border-t border-nature-800/80 flex items-center justify-between flex-wrap gap-2">
                        <span className="text-xs text-nature-400">Need to bootstrap a fresh node setup from scratch?</span>
                        <button
                            type="button"
                            onClick={onStartColdStartWizard}
                            className="px-3.5 py-1.5 rounded-lg bg-bp-chip-need-tint hover:opacity-90 text-xs font-bold text-bp-chip-need-ink border border-terra-600/50 transition-all"
                        >
                            Launch Cold-Start Wizard →
                        </button>
                    </div>
                )}
            </div>

            {FEEDBACK_LIVE && <SuggestChangePanel appVersion={version} />}
        </div>
    );
}

/** A figure card's number, or what stands in its place: never a 0 for a figure that didn't arrive. */
function FigureValue({ value, unit, loading }: { value: string | null; unit?: string; loading: boolean }) {
    if (value === null) {
        return (
            <div className="text-base font-bold text-nature-300 mb-1 min-h-[2.25rem] flex items-center">
                {loading ? 'Loading…' : "Couldn't load"}
            </div>
        );
    }
    return (
        <div className="text-3xl font-black text-white mb-1 group-hover:text-bp-ink-terra transition-colors">
            {value}
            {unit && <>{' '}<span className="text-xs font-normal text-nature-400">{unit}</span></>}
        </div>
    );
}

function RetryButton({ onClick, label }: { onClick: () => void; label: string }) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={label}
            className="min-h-[44px] px-3.5 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all shrink-0"
        >
            Retry
        </button>
    );
}

/** "a", "a and b", "a, b and c". */
function listInWords(parts: string[]): string {
    return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function capitalised(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}
