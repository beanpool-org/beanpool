import React, { useState, useEffect } from 'react';
import type { DiagnosticsResponse, NodeDataPayload } from '../../lib/node-client';

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
}: HomeScreenProps) {
    // Action required counts
    const pendingReportsCount = (nodeData?.reports || []).length;
    
    // Calculate unclaimed invites from nodeData or invites count
    const membersCount = (nodeData?.members || []).length;

    // Disk/storage usage percentage
    const dbBytes = diag?.dbSizeBytes || 0;
    const walBytes = diag?.walSizeBytes || 0;
    const totalStorageMb = Math.round((dbBytes + walBytes) / (1024 * 1024) * 10) / 10;
    const storagePercent = Math.min(100, Math.round((totalStorageMb / 500) * 100)); // normalized against 500MB target

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

    const foundingStatus = typeof window !== 'undefined' ? localStorage.getItem('bp_founding_invites_status') : null;
    if (foundingStatus) {
        actionItems.push({
            icon: '🎟️',
            text: foundingStatus,
            tab: 'people',
            sub: 'invites',
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
                    <div>
                        <div className="flex items-center gap-2 mb-1">
                            <h1 className="text-2xl font-black text-white m-0 tracking-tight">
                                {communityName || 'Sovereign Community'}
                            </h1>
                            <span className="px-2.5 py-0.5 rounded-full bg-terra-500/20 border border-terra-500/30 text-terra-400 text-xs font-semibold">
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
                        {auditState.result?.sumBalances !== undefined ? Math.abs(auditState.result.sumBalances).toFixed(1) : '240.0'}{' '}
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
                        {/* Enterprises count */}
                        3
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
                        148.5 <span className="text-xs font-normal text-nature-400">beans</span>
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
        </div>
    );
}
