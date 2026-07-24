import React, { useState } from 'react';
import { ThreatReviewModal } from './ThreatReviewModal';
import { MemberDetailModal } from './MemberDetailModal';

interface MembersModuleProps {
    nodeData: any | null;
    nodeDataLoading: boolean;
    onRefresh: () => void;
    onFreezeUser?: (pubkey: string, freeze: boolean) => Promise<void>;
    onPruneUser?: (pubkey: string) => Promise<void>;
    onUpdateTier?: (pubkey: string, tier: 'Newcomer' | 'Resident' | 'Steward' | 'Elder') => Promise<void>;
    onToggleVoucher?: (pubkey: string, canVouch: boolean) => Promise<void>;
}

export function getMemberAvatar(m: any, profiles: any[] = []): string | null {
    const pub = m?.publicKey || m?.pubkey || '';
    const profile = profiles.find((p) => p && (p.publicKey === pub || p.pubkey === pub));
    return profile?.avatar || profile?.avatarUrl || m?.avatarUrl || m?.avatar || null;
}

export function fmtDate(iso?: string | null): string {
    if (!iso) return 'N/A';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return 'N/A';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtLastActive(iso?: string | null): string {
    if (!iso) return 'Unknown';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return 'Unknown';
    const days = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
    if (days <= 0) return 'Active today';
    if (days === 1) return 'Active yesterday';
    if (days < 7) return `Active ${days}d ago`;
    if (days < 30) return `Active ${Math.floor(days / 7)}w ago`;
    return `Active ${d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`;
}

export function getMemberDisplayName(m: any, profiles: any[] = []): string {
    const pub = m?.publicKey || m?.pubkey || '';
    if (pub === 'SYSTEM' || pub.startsWith('SYSTEM')) return 'System Node Operator';

    // Look up in profiles array
    const profile = profiles.find((p) => p && (p.publicKey === pub || p.pubkey === pub));
    if (profile?.name?.trim()) return profile.name.trim();
    if (profile?.displayName?.trim()) return profile.displayName.trim();
    if (profile?.callsign?.trim()) return profile.callsign.trim();
    if (profile?.handle?.trim()) return `@${profile.handle.trim()}`;

    // Direct properties on member object
    if (m?.name?.trim()) return m.name.trim();
    if (m?.displayName?.trim()) return m.displayName.trim();
    if (m?.callsign?.trim()) return m.callsign.trim();
    if (m?.handle?.trim()) return `@${m.handle.trim()}`;

    if (pub.includes('-')) {
        const prefix = pub.split('-')[0];
        return `${prefix.charAt(0).toUpperCase() + prefix.slice(1)} Member`;
    }

    if (pub.length > 8) {
        return `Member (${pub.slice(0, 8)})`;
    }

    return pub || 'Sovereign Member';
}

export function getMemberTier(m: any): string {
    if (!m) return 'Citizen';
    const pub = m.publicKey || m.pubkey || '';
    if (pub === 'SYSTEM' || pub.startsWith('SYSTEM')) return 'Elder';

    if (m.tier && m.tier !== 'Citizen') return m.tier;
    if (m.standing && m.standing !== 'Citizen' && m.standing !== 'FROZEN') return m.standing;
    if (m.role && m.role !== 'Citizen') return m.role;

    const earned = typeof m.earnedCredit === 'number' ? m.earnedCredit : (typeof m.earned_credit === 'number' ? m.earned_credit : 0);
    if (earned >= 1400) return 'Elder';
    if (earned >= 600) return 'Steward';
    if (earned >= 200) return 'Resident';

    if (m.canVouch || m.isVoucher) return 'Elder';

    return 'Citizen';
}

export function MembersModule({ nodeData, nodeDataLoading, onRefresh, onFreezeUser, onPruneUser, onUpdateTier, onToggleVoucher }: MembersModuleProps) {
    const [searchTerm, setSearchTerm] = useState('');
    const [activeThreat, setActiveThreat] = useState<any | null>(null);
    const [selectedMember, setSelectedMember] = useState<any | null>(null);
    const [tierEditMember, setTierEditMember] = useState<any | null>(null);
    const [selectedTierValue, setSelectedTierValue] = useState<'Newcomer' | 'Resident' | 'Steward' | 'Elder'>('Resident');
    const [isUpdatingTier, setIsUpdatingTier] = useState(false);
    const [frozenPubkeys, setFrozenPubkeys] = useState<Set<string>>(new Set());
    const [customVouchers, setCustomVouchers] = useState<Set<string>>(new Set());

    const handlePruneMember = async (pubkey: string) => {
        if (!onPruneUser) return;
        try {
            await onPruneUser(pubkey);
            onRefresh();
            setSelectedMember(null);
        } catch (e: any) {
            alert(`Failed to prune member: ${e.message || e}`);
        }
    };

    const handleApplyTierUpgrade = async () => {
        if (!tierEditMember || !onUpdateTier) return;
        const pubkey = tierEditMember.publicKey || tierEditMember.pubkey;
        if (!pubkey) return;

        setIsUpdatingTier(true);
        try {
            await onUpdateTier(pubkey, selectedTierValue);
            setTierEditMember(null);
            onRefresh();
        } catch (e: any) {
            alert(e?.message || 'Failed to update member tier');
        } finally {
            setIsUpdatingTier(false);
        }
    };

    React.useEffect(() => {
        if (nodeData?.members) {
            const serverFrozen = new Set<string>(
                nodeData.members
                    .filter((m: any) => m.creditFrozen || m.isFrozen || m.status === 'frozen')
                    .map((m: any) => m.publicKey || m.pubkey)
                    .filter(Boolean)
            );
            setFrozenPubkeys(serverFrozen);

            const serverVouchers = new Set<string>(
                nodeData.members
                    .filter((m: any) => m.canVouch || m.isVoucher)
                    .map((m: any) => m.publicKey || m.pubkey)
                    .filter(Boolean)
            );
            setCustomVouchers(serverVouchers);
        }
    }, [nodeData]);

    const handleFreezePubkeys = async (pubkeys: string[]) => {
        setFrozenPubkeys((prev) => {
            const next = new Set(prev);
            pubkeys.forEach((p) => next.add(p));
            return next;
        });
        if (onFreezeUser) {
            for (const p of pubkeys) {
                try {
                    await onFreezeUser(p, true);
                } catch {}
            }
            onRefresh();
        }
    };

    const handleToggleFreezeMember = async (pubkey: string) => {
        const isCurrentlyFrozen = Array.from(frozenPubkeys).some(
            (f) => f === pubkey || (pubkey && f && (pubkey.startsWith(f) || f.startsWith(pubkey)))
        );
        setFrozenPubkeys((prev) => {
            const next = new Set(prev);
            const matches = Array.from(next).filter(
                (f) => f === pubkey || (pubkey && f && (pubkey.startsWith(f) || f.startsWith(pubkey)))
            );
            if (matches.length > 0) {
                matches.forEach((m) => next.delete(m));
            } else {
                next.add(pubkey);
            }
            return next;
        });
        if (onFreezeUser) {
            try {
                await onFreezeUser(pubkey, !isCurrentlyFrozen);
                onRefresh();
            } catch {}
        }
    };

    const handleToggleVouchMember = async (pubkey: string, isCurrentlyVoucher: boolean) => {
        const nextState = !isCurrentlyVoucher;
        setCustomVouchers((prev) => {
            const next = new Set(prev);
            const matches = Array.from(next).filter(
                (v) => v === pubkey || (pubkey && v && (pubkey.startsWith(v) || v.startsWith(pubkey)))
            );
            if (nextState) {
                next.add(pubkey);
            } else {
                matches.forEach((m) => next.delete(m));
            }
            return next;
        });
        if (onToggleVoucher) {
            try {
                await onToggleVoucher(pubkey, nextState);
                onRefresh();
            } catch (e: any) {
                alert(e?.message || 'Failed to update voucher status on server');
            }
        }
    };

    const [dismissedFlags, setDismissedFlags] = useState<Set<string>>(() => {
        try {
            const saved = localStorage.getItem('bp_dismissed_flags');
            if (saved) {
                return new Set(JSON.parse(saved));
            }
        } catch {}
        return new Set();
    });

    const handleDismissThreat = (threat: any) => {
        if (!threat) return;
        const key = threat.id || threat.type || threat.description || threat.targetPubkey || threat.reason;
        setDismissedFlags((prev) => {
            const next = new Set(prev);
            if (key) next.add(key);
            try {
                localStorage.setItem('bp_dismissed_flags', JSON.stringify(Array.from(next)));
            } catch {}
            return next;
        });
        setActiveThreat(null);
    };

    const members = nodeData?.members || [];
    const profiles = nodeData?.profiles || [];
    const posts = nodeData?.posts || [];
    const health = nodeData?.health;
    const rawReports = nodeData?.reports || [];
    const rawFlags = health?.flags || [];

    const flags = rawFlags.filter(
        (f: any) => !dismissedFlags.has(f.id || f.type || f.description)
    );
    const reports = rawReports.filter(
        (r: any) => !dismissedFlags.has(r.id || r.targetPubkey || r.reason)
    );

    const filteredMembers = members.filter((m: any) => {
        if (m.status === 'pruned') return false;
        const name = getMemberDisplayName(m, profiles).toLowerCase();
        const pub = (m.publicKey || '').toLowerCase();
        const term = searchTerm.toLowerCase();
        return name.includes(term) || pub.includes(term);
    });

    const platformTallies = React.useMemo(() => {
        let ios = 0;
        let android = 0;
        let pwa = 0;
        let unknown = 0;

        members.forEach((m: any) => {
            const plat = (m.platform || '').toLowerCase();
            if (plat === 'ios') ios++;
            else if (plat === 'android') android++;
            else if (plat === 'web' || plat === 'pwa') pwa++;
            else unknown++;
        });

        return { ios, android, pwa, unknown };
    }, [members]);

    return (
        <div className="bg-nature-900/80 border border-nature-800 rounded-2xl p-6 space-y-6 shadow-xl font-sans animate-fade-in">
            <div className="flex items-center justify-between">
                <div>
                    <h3 className="text-lg font-bold text-white m-0 flex items-center gap-2">
                        <span>👥 Sovereign Trust Engine Inspector & Moderation Radar</span>
                    </h3>
                    <p className="text-xs text-nature-400 m-0 mt-1">
                        Calculates member trust score, monitors wash trading rings, and processes abuse reports.
                    </p>
                </div>
                <button
                    onClick={onRefresh}
                    disabled={nodeDataLoading}
                    className="px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all flex items-center gap-2 active:scale-95"
                >
                    <span className={nodeDataLoading ? 'animate-spin' : ''}>🔄</span>
                    <span>{nodeDataLoading ? 'Refreshing Data...' : 'Refresh Roster'}</span>
                </button>
            </div>

            {/* 🚨 Active Security & Abuse Detection Radar */}
            {(flags.length > 0 || reports.length > 0) && (
                <div className="bg-red-950/30 border border-red-800/80 p-5 rounded-2xl space-y-4">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-red-400 font-bold text-xs uppercase tracking-wider">
                            <span>🚨 Active Security Alerts & Abuse Radar ({flags.length + reports.length})</span>
                        </div>
                        <span className="px-2 py-0.5 rounded bg-red-900/40 text-red-300 text-[10px] font-mono font-bold border border-red-800">
                            ACTION REQUIRED
                        </span>
                    </div>

                    <div className="space-y-2 text-xs">
                        {flags.map((flag: any, idx: number) => (
                            <div key={idx} className="p-3 bg-nature-950/80 border border-red-900/60 rounded-xl flex items-start justify-between gap-3">
                                <div className="space-y-1">
                                    <div className="flex items-center gap-2">
                                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase font-mono ${
                                            flag.severity === 'critical' ? 'bg-red-600 text-white' : 'bg-amber-600 text-white'
                                        }`}>
                                            {flag.severity || 'ALERT'}
                                        </span>
                                        <span className="font-mono font-bold text-red-300 uppercase">{flag.type}</span>
                                    </div>
                                    <p className="text-nature-200 m-0">{flag.description}</p>
                                </div>
                                <button
                                    onClick={() => setActiveThreat(flag)}
                                    className="px-3 py-1 rounded-lg bg-red-900/50 hover:bg-red-900/80 text-red-200 text-[11px] font-bold transition-all border border-red-800 shrink-0"
                                >
                                    Review Threat
                                </button>
                            </div>
                        ))}

                        {reports.map((report: any, idx: number) => (
                            <div key={idx} className="p-3 bg-nature-950/80 border border-amber-900/60 rounded-xl flex items-start justify-between gap-3">
                                <div className="space-y-1">
                                    <div className="flex items-center gap-2">
                                        <span className="px-1.5 py-0.5 rounded bg-amber-600 text-white text-[9px] font-bold uppercase font-mono">
                                            USER REPORT
                                        </span>
                                        <span className="font-mono text-amber-300">Target: {report.targetPubkey?.slice(0, 12)}...</span>
                                    </div>
                                    <p className="text-nature-200 m-0">Reason: {report.reason || 'Abuse or spam reported by member'}</p>
                                </div>
                                <button
                                    onClick={() => setActiveThreat({ ...report, isReport: true })}
                                    className="px-3 py-1 rounded-lg bg-amber-900/50 hover:bg-amber-900/80 text-amber-200 text-[11px] font-bold transition-all border border-amber-800 shrink-0"
                                >
                                    Moderate Report
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {nodeData ? (
                <div className="space-y-6">
                    {/* Stat Badges */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3.5 text-xs">
                        <div className="bg-nature-950/60 border border-nature-800/80 p-4 rounded-xl space-y-1">
                            <span className="text-nature-400 block font-extrabold uppercase text-[10px] tracking-wider">Total Members</span>
                            <span className="text-2xl font-black text-white font-mono">{members.length}</span>
                        </div>
                        <div className="bg-nature-950/60 border border-nature-800/80 p-4 rounded-xl space-y-1">
                            <span className="text-nature-400 block font-extrabold uppercase text-[10px] tracking-wider">Device Platforms</span>
                            <div className="flex items-center gap-1.5 font-mono pt-1 text-[11px]">
                                <span className="px-1.5 py-0.5 rounded bg-sky-950/80 text-sky-300 border border-sky-800/80 font-bold" title="iOS Native App Users">
                                    📱 {platformTallies.ios}
                                </span>
                                <span className="px-1.5 py-0.5 rounded bg-emerald-950/80 text-emerald-300 border border-emerald-800/80 font-bold" title="Android Native App Users">
                                    🤖 {platformTallies.android}
                                </span>
                                <span className="px-1.5 py-0.5 rounded bg-purple-950/80 text-purple-300 border border-purple-800/80 font-bold" title="PWA Web Users">
                                    🌐 {platformTallies.pwa}
                                </span>
                            </div>
                        </div>
                        <div className="bg-nature-950/60 border border-nature-800/80 p-4 rounded-xl space-y-1">
                            <span className="text-nature-400 block font-extrabold uppercase text-[10px] tracking-wider">Active Vouchers</span>
                            <span className="text-2xl font-black text-emerald-400 font-mono">
                                {members.filter((m: any) => {
                                    const pk = m.publicKey || m.pubkey || '';
                                    const frozen = Array.from(frozenPubkeys).some(f => pk === f || (pk && f && (pk.startsWith(f) || f.startsWith(pk))));
                                    if (frozen) return false;
                                    return m.canVouch || Array.from(customVouchers).some(v => pk === v || (pk && v && (pk.startsWith(v) || v.startsWith(pk))));
                                }).length}
                            </span>
                        </div>
                        <div className="bg-nature-950/60 border border-nature-800/80 p-4 rounded-xl space-y-1">
                            <span className="text-nature-400 block font-extrabold uppercase text-[10px] tracking-wider">Active Listings</span>
                            <span className="text-2xl font-black text-sky-400 font-mono">{posts.length}</span>
                        </div>
                        <div className="bg-nature-950/60 border border-nature-800/80 p-4 rounded-xl space-y-1">
                            <span className="text-nature-400 block font-extrabold uppercase text-[10px] tracking-wider">Community Standing</span>
                            <span className="text-2xl font-black text-amber-400 uppercase font-mono">
                                {health?.healthScore !== undefined ? `${health.healthScore}%` : 'ONLINE'}
                            </span>
                        </div>
                    </div>

                    {/* Member Roster Table */}
                    <div className="space-y-3">
                        <div className="flex items-center justify-between gap-4">
                            <h4 className="text-xs font-extrabold text-nature-300 uppercase tracking-wider">
                                Node Member Roster & Trust Inspector ({filteredMembers.length})
                            </h4>
                            <input
                                type="text"
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                placeholder="Filter members by name or pubkey..."
                                className="bg-nature-950 border border-nature-800 px-3 py-1.5 rounded-xl text-white font-mono text-xs focus:outline-none focus:border-terra-500 w-64 shadow-inner"
                            />
                        </div>

                        {filteredMembers.length > 0 ? (
                            <div className="bg-nature-950/80 border border-nature-800 rounded-xl overflow-hidden text-xs">
                                <div className="grid grid-cols-12 bg-nature-900/90 p-3 text-nature-400 font-bold border-b border-nature-800">
                                    <div className="col-span-5">Member Identity</div>
                                    <div className="col-span-3">Standing / Tier</div>
                                    <div className="col-span-2">Can Vouch</div>
                                    <div className="col-span-2 text-right">Actions</div>
                                </div>
                                <div className="divide-y divide-nature-800/60">
                                    {filteredMembers.map((m: any, idx: number) => {
                                        const displayName = getMemberDisplayName(m, profiles);
                                        const pubkey = m.publicKey || m.pubkey || '';
                                        const initial = displayName.charAt(0).toUpperCase();

                                        const isMemberFrozen =
                                            Array.from(frozenPubkeys).some(
                                                (f) => pubkey === f || (pubkey && f && (pubkey.startsWith(f) || f.startsWith(pubkey)))
                                            ) ||
                                            m.standing === 'FROZEN' ||
                                            pubkey.startsWith('frozen-');

                                        return (
                                            <div
                                                key={idx}
                                                onClick={() => setSelectedMember(m)}
                                                className={`grid grid-cols-12 p-3 items-center text-nature-200 transition-all cursor-pointer group ${
                                                    isMemberFrozen
                                                        ? 'bg-red-950/20 hover:bg-red-950/40 border-l-2 border-red-600'
                                                        : 'hover:bg-nature-900/60'
                                                }`}
                                            >
                                                <div className="col-span-5 flex items-center gap-2.5">
                                                    {(() => {
                                                        const avatar = getMemberAvatar(m, profiles);
                                                        if (avatar) {
                                                            return (
                                                                <img
                                                                    src={avatar}
                                                                    alt={displayName}
                                                                    className="w-7 h-7 rounded-full object-cover shrink-0 border border-terra-500/40 shadow-sm"
                                                                />
                                                            );
                                                        }
                                                        return (
                                                            <div className={`w-7 h-7 rounded-full flex items-center justify-center font-bold text-xs shrink-0 border ${
                                                                isMemberFrozen
                                                                    ? 'bg-red-950 text-red-400 border-red-800'
                                                                    : 'bg-terra-600/30 text-terra-300 border-terra-500/30'
                                                            }`}>
                                                                {initial}
                                                            </div>
                                                        );
                                                    })()}
                                                    <div className="min-w-0">
                                                        <div className="font-bold text-white truncate flex items-center gap-1.5 group-hover:text-terra-400 transition-colors">
                                                            <span>{displayName}</span>
                                                            {m.platform && m.platform !== 'unknown' && (
                                                                <span
                                                                    className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-bold border shrink-0 ${
                                                                        m.platform.toLowerCase() === 'ios'
                                                                            ? 'bg-sky-950/80 text-sky-300 border-sky-800/80'
                                                                            : m.platform.toLowerCase() === 'android'
                                                                            ? 'bg-emerald-950/80 text-emerald-300 border-emerald-800/80'
                                                                            : 'bg-purple-950/80 text-purple-300 border-purple-800/80'
                                                                    }`}
                                                                    title={`Device Platform: ${m.platform.toUpperCase()}`}
                                                                >
                                                                    {m.platform.toLowerCase() === 'ios'
                                                                        ? '📱 iOS'
                                                                        : m.platform.toLowerCase() === 'android'
                                                                        ? '🤖 Android'
                                                                        : '🌐 PWA'}
                                                                </span>
                                                            )}
                                                        </div>
                                                        <code className="text-[10px] text-nature-500 font-mono truncate block">
                                                            {pubkey ? `${pubkey.slice(0, 20)}...` : ''}
                                                        </code>
                                                    </div>
                                                </div>
                                                <div className="col-span-3 font-mono text-xs font-semibold uppercase">
                                                    {isMemberFrozen ? (
                                                        <span className="px-2 py-0.5 rounded bg-red-600 text-white font-bold text-[10px] shadow-sm">
                                                            🛑 FROZEN
                                                        </span>
                                                    ) : (
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                setTierEditMember(m);
                                                                const currentTier = getMemberTier(m);
                                                                const valid = ['Newcomer', 'Resident', 'Steward', 'Elder'].find(
                                                                    (t) => t.toLowerCase() === currentTier.toLowerCase()
                                                                );
                                                                setSelectedTierValue((valid as any) || 'Elder');
                                                            }}
                                                            title="Click to upgrade or edit member standing tier"
                                                            className="px-2.5 py-1 rounded bg-nature-900 hover:bg-nature-800 text-amber-400 hover:text-amber-300 font-bold text-xs border border-nature-800 transition-all hover:scale-105 flex items-center gap-1.5 cursor-pointer shadow-sm"
                                                        >
                                                            <span>{getMemberTier(m)}</span>
                                                            <span className="text-[10px] text-nature-400 hover:text-white">✏️ Upgrade</span>
                                                        </button>
                                                    )}
                                                </div>
                                                <div className="col-span-2">
                                                    {isMemberFrozen ? (
                                                        <span className="px-2 py-0.5 rounded-md bg-red-950 text-red-400 text-[10px] font-bold border border-red-900">
                                                            REVOKED
                                                        </span>
                                                    ) : (m.canVouch || Array.from(customVouchers).some(v => pubkey === v || (pubkey && v && (pubkey.startsWith(v) || v.startsWith(pubkey))))) ? (
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleToggleVouchMember(pubkey, true);
                                                            }}
                                                            title="Click to toggle voucher authority"
                                                            className="px-2 py-0.5 rounded-md bg-emerald-900/40 hover:bg-emerald-800/60 text-emerald-400 text-[10px] font-bold border border-emerald-800/60 transition-all hover:scale-105"
                                                        >
                                                            🛡️ VOUCHER
                                                        </button>
                                                    ) : (
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleToggleVouchMember(pubkey, false);
                                                            }}
                                                            title="Click to nominate / grant voucher authority"
                                                            className="px-2 py-0.5 rounded-md bg-nature-900 hover:bg-nature-800 text-nature-400 hover:text-emerald-300 text-[10px] font-semibold border border-nature-800 transition-all hover:scale-105 flex items-center gap-1"
                                                        >
                                                            <span>STANDARD</span>
                                                            <span className="text-[9px] opacity-60">+ Nominate</span>
                                                        </button>
                                                    )}
                                                </div>
                                                <div className="col-span-2 text-right flex items-center justify-end gap-1.5">
                                                    {isMemberFrozen && (
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleToggleFreezeMember(pubkey);
                                                            }}
                                                            className="px-2.5 py-1 rounded bg-emerald-900/60 hover:bg-emerald-800 text-emerald-200 text-[10px] font-sans font-bold transition-all border border-emerald-700/80 shrink-0"
                                                        >
                                                            🟢 Unfreeze
                                                        </button>
                                                    )}
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setSelectedMember(m);
                                                        }}
                                                        className="px-2.5 py-1 rounded bg-nature-800 hover:bg-nature-700 text-white text-[10px] font-sans font-bold transition-all border border-nature-700 shrink-0"
                                                    >
                                                        Inspect
                                                    </button>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        ) : (
                            <div className="p-8 text-center text-nature-500 text-xs">
                                No member records match the filter query.
                            </div>
                        )}
                    </div>
                </div>
            ) : (
                <div className="p-12 text-center text-nature-400 text-xs">
                    {nodeDataLoading
                        ? 'Fetching node member roster from target API...'
                        : 'Authenticate with Admin Password to view node member standing and trust calculations.'}
                </div>
            )}

            {activeThreat && (
                <ThreatReviewModal
                    threat={activeThreat}
                    profiles={profiles}
                    members={members}
                    frozenPubkeys={frozenPubkeys}
                    onClose={() => setActiveThreat(null)}
                    onDismiss={handleDismissThreat}
                    onFreezePubkeys={handleFreezePubkeys}
                    onInspectMember={(m) => setSelectedMember(m)}
                />
            )}

            {selectedMember && (
                <MemberDetailModal
                    member={selectedMember}
                    profiles={profiles}
                    flags={flags}
                    isFrozen={
                        Array.from(frozenPubkeys).some((f) => {
                            const pk = selectedMember.publicKey || selectedMember.pubkey || '';
                            return pk === f || (pk && f && (pk.startsWith(f) || f.startsWith(pk)));
                        }) ||
                        selectedMember.standing === 'FROZEN' ||
                        (selectedMember.publicKey || selectedMember.pubkey || '').startsWith('frozen-')
                    }
                    isVoucher={
                        selectedMember.canVouch ||
                        Array.from(customVouchers).some((v) => {
                            const pk = selectedMember.publicKey || selectedMember.pubkey || '';
                            return pk === v || (pk && v && (pk.startsWith(v) || v.startsWith(pk)));
                        })
                    }
                    onToggleFreeze={handleToggleFreezeMember}
                    onToggleVouch={(pk, isV) => handleToggleVouchMember(pk, isV)}
                    onPrune={(pk) => handlePruneMember(pk)}
                    onClose={() => setSelectedMember(null)}
                />
            )}

            {/* Member Standing & Tier Upgrade Modal */}
            {tierEditMember && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 z-50 font-sans animate-fade-in">
                    <div className="bg-nature-900 border border-nature-800 rounded-3xl p-6 max-w-md w-full space-y-5 text-left shadow-2xl">
                        <div className="flex items-center justify-between border-b border-nature-800 pb-3">
                            <div>
                                <h3 className="text-base font-bold text-white m-0">🌟 Upgrade Member Standing Tier</h3>
                                <p className="text-xs text-nature-400 m-0 mt-0.5">
                                    Assign tier badge & granted credit floor for <code className="text-terra-400 font-bold">{getMemberDisplayName(tierEditMember, profiles)}</code>
                                </p>
                            </div>
                            <button
                                onClick={() => setTierEditMember(null)}
                                className="text-nature-500 hover:text-white text-lg"
                            >
                                ✕
                            </button>
                        </div>

                        <div className="space-y-3 text-xs">
                            <div>
                                <label className="block text-nature-300 font-semibold mb-2">Select Standing / Tier Badge:</label>
                                <div className="space-y-2">
                                    {[
                                        { id: 'Newcomer', name: '🥚 NEWCOMER', desc: 'Entry floor (0 granted credit limit)' },
                                        { id: 'Resident', name: '🏠 RESIDENT', desc: '-200 granted credit floor (verified community member)' },
                                        { id: 'Steward', name: '🏛️ STEWARD', desc: '-600 granted credit floor (active steward & voucher)' },
                                        { id: 'Elder', name: '⛰️ ELDER', desc: '-1400 granted credit floor (founding governance tier)' },
                                    ].map((t) => (
                                        <label
                                            key={t.id}
                                            className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                                                selectedTierValue === t.id
                                                    ? 'bg-terra-950/60 border-terra-500 text-white'
                                                    : 'bg-nature-950/60 border-nature-800 text-nature-300 hover:border-nature-700'
                                            }`}
                                        >
                                            <input
                                                type="radio"
                                                name="tier"
                                                value={t.id}
                                                checked={selectedTierValue === t.id}
                                                onChange={() => setSelectedTierValue(t.id as any)}
                                                className="mt-0.5 accent-terra-500"
                                            />
                                            <div>
                                                <div className="font-bold text-xs">{t.name}</div>
                                                <div className="text-[11px] text-nature-400 mt-0.5">{t.desc}</div>
                                            </div>
                                        </label>
                                    ))}
                                </div>
                            </div>
                        </div>

                        <div className="pt-3 border-t border-nature-800 flex justify-end gap-3">
                            <button
                                onClick={() => setTierEditMember(null)}
                                className="px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-white font-bold text-xs transition-all"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleApplyTierUpgrade}
                                disabled={isUpdatingTier}
                                className="px-5 py-2 rounded-xl bg-terra-500 hover:bg-terra-600 disabled:opacity-50 font-bold text-white text-xs transition-all shadow-md flex items-center gap-2"
                            >
                                {isUpdatingTier && <span className="animate-spin">🔄</span>}
                                <span>{isUpdatingTier ? 'Applying Upgrade...' : 'Apply Tier Upgrade'}</span>
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
