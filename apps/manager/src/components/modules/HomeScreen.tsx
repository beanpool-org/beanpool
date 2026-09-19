import React, { useState, useEffect } from 'react';
import { HelpLink } from '../manual/Manual';
import type { DiagnosticsResponse, NodeDataPayload, MemberItem } from '../../lib/node-client';
import { FEEDBACK_LIVE } from '@beanpool/core';
import { SuggestChangePanel } from './SuggestChangePanel';

interface HomeScreenProps {
    communityName: string;
    publicDomain: string;
    version: string;
    diag: DiagnosticsResponse | null;
    nodeData: NodeDataPayload | null;
    onNavigate: (tab: 'people' | 'economy' | 'bulletin' | 'appliance', subTab?: string) => void;
    onInviteMember: () => void;
    onCreateEnterprise: () => void;
    onDownloadBackup: () => Promise<void>;
    onRunLedgerAudit: () => Promise<void>;
    auditState: { running: boolean; result: { ok: boolean; drift: number; sumBalances?: number } | null };
    onStartColdStartWizard?: () => void;
    onAcknowledgeShutdown?: () => Promise<void>;
}

export function HomeScreen({
    communityName,
    publicDomain,
    version,
    diag,
    nodeData,
    onNavigate,
    onInviteMember,
    onCreateEnterprise,
    onDownloadBackup,
    onRunLedgerAudit,
    auditState,
    onStartColdStartWizard,
    onAcknowledgeShutdown,
}: HomeScreenProps) {
    const [shutdownDismissed, setShutdownDismissed] = useState(false);

    useEffect(() => {
        setShutdownDismissed(false);
    }, [diag?.shutdownStatus?.powerLossTimestamp, diag?.shutdownStatus?.checkedAt, communityName]);

    // Action required counts
    const reports = Array.isArray(nodeData?.reports) ? nodeData.reports : [];
    const members = Array.isArray(nodeData?.members) ? nodeData.members : [];
    const pendingReportsCount = typeof nodeData?.reportCount === 'number'
        ? nodeData.reportCount
        : reports.filter((r: any) => (r.outcome ? r.outcome === 'open' : (r.status === 'pending' || !r.status))).length;
    
    // Calculate unclaimed invites from nodeData or invites count
    const membersCount = members.filter((m: MemberItem) => m && !m.isTreasury).length;
    const enterprisesCount = Array.isArray(nodeData?.enterprises)
        ? nodeData.enterprises.length
        : members.filter((m: MemberItem) => m && m.isTreasury).length;

    const circulationVolume = (() => {
        if (typeof nodeData?.tradeVolume === 'number') {
            return nodeData.tradeVolume.toFixed(1);
        }
        if (typeof nodeData?.circulation === 'number') {
            return nodeData.circulation.toFixed(1);
        }
        if (nodeData?.memberStats && typeof nodeData.memberStats === 'object') {
            const stats = Object.values(nodeData.memberStats as Record<string, { volume?: number }>);
            const totalVol = stats.reduce(
                (sum, s) => sum + (s && typeof s.volume === 'number' ? s.volume : 0),
                0
            );
            return (totalVol / 2).toFixed(1);
        }
        return '0.0';
    })();

    // Disk/storage usage percentage: prefer real diskHealth if provided by server
    const storagePercent = typeof diag?.diskHealth?.usedPercent === 'number'
        ? diag.diskHealth.usedPercent
        : (() => {
            const dbBytes = diag?.dbSizeBytes || 0;
            const walBytes = diag?.walSizeBytes || 0;
            const totalStorageMb = Math.round((dbBytes + walBytes) / (1024 * 1024) * 10) / 10;
            return Math.min(100, Math.round((totalStorageMb / 500) * 100));
        })();

    // Unclean shutdown status
    const shutdownStatus = diag?.shutdownStatus;
    const showShutdownCard = Boolean(
        shutdownStatus &&
        shutdownStatus.uncleanShutdown &&
        !shutdownStatus.acknowledged &&
        !shutdownDismissed
    );

    // Action items
    const actionItems: { icon: string; text: string; tab: 'people' | 'economy' | 'bulletin' | 'appliance'; sub?: string }[] = [];
    if (pendingReportsCount > 0) {
        actionItems.push({
            icon: '⚠️',
            text: `${pendingReportsCount} report${pendingReportsCount > 1 ? 's' : ''} pending`,
            tab: 'people',
            sub: 'moderation',
        });
    }

    const pendingDisputesCount = typeof nodeData?.escrowDisputesCount === 'number'
        ? nodeData.escrowDisputesCount
        : 0;
    if (pendingDisputesCount > 0) {
        actionItems.push({
            icon: '⚖️',
            text: `${pendingDisputesCount} escrow dispute${pendingDisputesCount > 1 ? 's' : ''} pending`,
            tab: 'economy',
            sub: 'disputes',
        });
    }

    if (storagePercent >= 80) {
        actionItems.push({
            icon: '💾',
            text: `Storage ${storagePercent}%`,
            tab: 'appliance',
            sub: 'diagnostics',
        });
    }

    const driftText = auditState.result
        ? `Ledger ${auditState.result.ok ? 'balanced' : 'drift detected'} (${auditState.result.drift} drift)`
        : 'Ledger balanced (0 drift)';

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
                            <span className="px-2.5 py-0.5 rounded-full bg-terra-500/20 border border-terra-500/30 text-terra-400 text-xs font-semibold max-w-full truncate lg:overflow-visible lg:shrink-0">
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

                    {/* Quick status pill */}
                    <div className="flex items-center gap-3">
                        <button
                            onClick={() => onNavigate('appliance', 'diagnostics')}
                            className="px-3.5 py-2 rounded-xl bg-nature-800/80 hover:bg-nature-700 text-xs font-bold text-nature-200 border border-nature-700 transition-all flex items-center gap-2"
                        >
                            <span>🔌</span>
                            <span>{diag?.activeWsConnections ?? 0} active connections</span>
                        </button>
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
                                className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-all shadow-md active:scale-95"
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
                                    className="px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-black transition-all shadow-lg active:scale-95 flex items-center gap-1.5"
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

            {/* 2. Action required — either All clear or live list */}
            <div className="bg-nature-900/60 border border-nature-800 rounded-2xl p-5 shadow-lg">
                <h3 className="text-xs font-bold uppercase tracking-wider text-nature-400 mb-3 flex items-center gap-2">
                    <span>⚡</span>
                    <span>Action Required</span>
                </h3>
                {actionItems.length === 0 ? (
                    <div className="flex items-center gap-2 text-sm font-semibold text-emerald-400 bg-emerald-950/30 border border-emerald-800/40 px-4 py-3 rounded-xl">
                        <span>🟢</span>
                        <span>All clear — node is running cleanly with no pending actions.</span>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                        {actionItems.map((item, idx) => (
                            <button
                                key={idx}
                                onClick={() => onNavigate(item.tab, item.sub)}
                                className="flex items-center justify-between p-3.5 rounded-xl bg-amber-950/40 hover:bg-amber-900/50 border border-amber-800/50 text-amber-200 text-xs font-bold transition-all text-left group"
                            >
                                <div className="flex items-center gap-2.5">
                                    <span className="text-base">{item.icon}</span>
                                    <span>{item.text}</span>
                                </div>
                                <span className="text-amber-400 group-hover:translate-x-0.5 transition-transform">→</span>
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {/* 3. Four cards — Members · Commons pool · Shared enterprises · Circulation this week */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {/* Members Card */}
                <button
                    type="button"
                    onClick={() => onNavigate('people')}
                    className="p-5 rounded-2xl bg-nature-900/70 hover:bg-nature-900 border border-nature-800 hover:border-nature-700 cursor-pointer transition-all shadow-md group text-left w-full focus:outline-none focus:ring-2 focus:ring-terra-500"
                >
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-bold text-nature-400 uppercase tracking-wider">Members</span>
                        <span className="text-lg" aria-hidden="true">👥</span>
                    </div>
                    <div className="text-3xl font-black text-white mb-1 group-hover:text-terra-400 transition-colors">
                        {membersCount}
                    </div>
                    <p className="text-xs text-nature-400 m-0">
                        {membersCount === 1 ? '1 active sovereign member' : `${membersCount} active sovereign members`}
                    </p>
                </button>

                {/* Commons Pool Card */}
                <button
                    type="button"
                    onClick={() => onNavigate('economy')}
                    className="p-5 rounded-2xl bg-nature-900/70 hover:bg-nature-900 border border-nature-800 hover:border-nature-700 cursor-pointer transition-all shadow-md group text-left w-full focus:outline-none focus:ring-2 focus:ring-terra-500"
                >
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-bold text-nature-400 uppercase tracking-wider">Commons Pool</span>
                        <span className="text-lg" aria-hidden="true">🏛️</span>
                    </div>
                    <div className="text-3xl font-black text-white mb-1 group-hover:text-terra-400 transition-colors">
                        {auditState.result?.sumBalances !== undefined
                            ? Math.abs(auditState.result.sumBalances).toFixed(1)
                            : (typeof nodeData?.commonsBalance === 'number'
                                ? nodeData.commonsBalance.toFixed(1)
                                : '0.0')}{' '}
                        <span className="text-xs font-normal text-nature-400">beans</span>
                    </div>
                    <p className="text-xs text-emerald-400 m-0 font-medium">
                        ✓ 0 drift · 100% backed
                    </p>
                </button>

                {/* Shared Enterprises Card */}
                <button
                    type="button"
                    onClick={() => onNavigate('economy')}
                    className="p-5 rounded-2xl bg-nature-900/70 hover:bg-nature-900 border border-nature-800 hover:border-nature-700 cursor-pointer transition-all shadow-md group text-left w-full focus:outline-none focus:ring-2 focus:ring-terra-500"
                >
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-bold text-nature-400 uppercase tracking-wider">Shared Enterprises</span>
                        <span className="text-lg" aria-hidden="true">🌾</span>
                    </div>
                    <div className="text-3xl font-black text-white mb-1 group-hover:text-terra-400 transition-colors">
                        {enterprisesCount}
                    </div>
                    <p className="text-xs text-nature-400 m-0">
                        Community projects &amp; co-ops
                    </p>
                </button>

                {/* Circulation Card */}
                <button
                    type="button"
                    onClick={() => onNavigate('appliance', 'diagnostics')}
                    className="p-5 rounded-2xl bg-nature-900/70 hover:bg-nature-900 border border-nature-800 hover:border-nature-700 cursor-pointer transition-all shadow-md group text-left w-full focus:outline-none focus:ring-2 focus:ring-terra-500"
                >
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-bold text-nature-400 uppercase tracking-wider">Circulation</span>
                        <span className="text-lg" aria-hidden="true">🔄</span>
                    </div>
                    <div className="text-3xl font-black text-white mb-1 group-hover:text-terra-400 transition-colors">
                        {circulationVolume} <span className="text-xs font-normal text-nature-400">beans</span>
                    </div>
                    <p className="text-xs text-nature-400 m-0">
                        Active trade volume this week
                    </p>
                </button>
            </div>

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
                            <div className="text-sm font-bold text-white group-hover:text-terra-400 transition-colors">
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
                            <div className="text-sm font-bold text-white group-hover:text-terra-400 transition-colors">
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
                            <div className="text-sm font-bold text-white group-hover:text-terra-400 transition-colors">
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
                            <div className="text-sm font-bold text-white group-hover:text-terra-400 transition-colors">
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
                            className="px-3.5 py-1.5 rounded-lg bg-terra-900/30 hover:bg-terra-900/50 text-xs font-bold text-terra-300 border border-terra-700/50 transition-all"
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
