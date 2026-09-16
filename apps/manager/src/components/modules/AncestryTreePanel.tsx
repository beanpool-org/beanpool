import React, { useState, useMemo } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { pruneInviteBranch, getTfaSessionToken } from '../../lib/node-client';
import { PruneBranchModal } from './PruneBranchModal';
import type { MemberItem } from './MembersModule';

export interface AncestryTreePanelProps {
    nodeData: any;
    nodeDataLoading?: boolean;
    activeNode: NodeProfile;
    onRefresh?: () => void;
    onPruneBranch?: (pubkey: string) => Promise<void>;
    onSelectMember?: (member: MemberItem) => void;
}

interface BranchStats {
    memberCount: number;
    posts: number;
    messages: number;
    deals: number;
    volume: number;
    cancelled: number;
}

export function AncestryTreePanel({
    nodeData,
    nodeDataLoading,
    activeNode,
    onRefresh,
    onPruneBranch,
    onSelectMember,
}: AncestryTreePanelProps) {
    const [searchQuery, setSearchQuery] = useState('');
    const [activeFilter, setActiveFilter] = useState<'all' | 'voucher' | 'threats' | 'reported' | 'frozen'>('all');
    const [expandedStats, setExpandedStats] = useState<Record<string, boolean>>({});
    const [expandedBranches, setExpandedBranches] = useState<Record<string, boolean>>({});
    const [pruneTarget, setPruneTarget] = useState<{ pubkey: string; callsign?: string } | null>(null);

    const members: MemberItem[] = useMemo(() => {
        return Array.isArray(nodeData?.members) ? nodeData.members : [];
    }, [nodeData?.members]);

    const accounts = useMemo(() => {
        return Array.isArray(nodeData?.accounts) ? nodeData.accounts : [];
    }, [nodeData?.accounts]);

    const profiles = useMemo(() => {
        return Array.isArray(nodeData?.profiles) ? nodeData.profiles : [];
    }, [nodeData?.profiles]);

    const healthFlags = useMemo(() => {
        return Array.isArray(nodeData?.health?.flags) ? nodeData.health.flags : [];
    }, [nodeData?.health?.flags]);

    const reports = useMemo(() => {
        return Array.isArray(nodeData?.reports) ? nodeData.reports : [];
    }, [nodeData?.reports]);

    const memberStats = useMemo(() => {
        return nodeData?.memberStats && typeof nodeData.memberStats === 'object'
            ? nodeData.memberStats
            : {};
    }, [nodeData?.memberStats]);

    // Lookup maps
    const membersMap = useMemo(() => {
        const map = new Map<string, MemberItem>();
        for (const m of members) {
            const pk = typeof m?.publicKey === 'string' ? m.publicKey : (typeof (m as any)?.pubkey === 'string' ? (m as any).pubkey : '');
            if (pk) map.set(pk, m);
        }
        return map;
    }, [members]);

    const profilesMap = useMemo(() => {
        const map = new Map<string, any>();
        for (const p of profiles) {
            const pk = typeof p?.publicKey === 'string' ? p.publicKey : (typeof (p as any)?.pubkey === 'string' ? (p as any).pubkey : '');
            if (pk) map.set(pk, p);
        }
        return map;
    }, [profiles]);

    // Reports per member count
    const reportsByMember = useMemo(() => {
        const counts: Record<string, number> = {};
        for (const r of reports) {
            const status = typeof r?.status === 'string' ? r.status : 'pending';
            if (status === 'pending') {
                const target = typeof r?.targetPubkey === 'string' ? r.targetPubkey : (typeof r?.target_pubkey === 'string' ? r.target_pubkey : '');
                if (target) counts[target] = (counts[target] || 0) + 1;
            }
        }
        return counts;
    }, [reports]);

    // Direct flags per member
    const nodeFlags = useMemo(() => {
        const flagsMap: Record<string, any[]> = {};
        for (const f of healthFlags) {
            const flagMembers = Array.isArray(f?.members) ? f.members : [];
            for (const m of flagMembers) {
                if (typeof m === 'string') {
                    if (!flagsMap[m]) flagsMap[m] = [];
                    flagsMap[m].push(f);
                }
            }
        }
        return flagsMap;
    }, [healthFlags]);

    // Tree structure by invitedBy
    const { tree, genesisRoots } = useMemo(() => {
        const t: Record<string, MemberItem[]> = {};
        const roots: MemberItem[] = [];

        for (const m of members) {
            const pk = typeof m?.publicKey === 'string' ? m.publicKey : (typeof (m as any)?.pubkey === 'string' ? (m as any).pubkey : '');
            if (!pk) continue;
            const inv = typeof m?.invitedBy === 'string'
                ? m.invitedBy
                : (typeof (m as any)?.invited_by === 'string' ? (m as any).invited_by : null);
            if (!inv || inv === 'genesis' || inv === pk || !membersMap.has(inv)) {
                roots.push(m);
            } else {
                if (!t[inv]) t[inv] = [];
                t[inv].push(m);
            }
        }

        // Ensure unrooted cyclic components or orphan subgraphs are still visible to operator
        const visitedInTree = new Set<string>();
        function markReachable(pk: string) {
            if (visitedInTree.has(pk)) return;
            visitedInTree.add(pk);
            const children = t[pk] || [];
            for (const child of children) {
                const cPk = typeof child?.publicKey === 'string' ? child.publicKey : (typeof (child as any)?.pubkey === 'string' ? (child as any).pubkey : '');
                if (cPk) markReachable(cPk);
            }
        }
        for (const r of roots) {
            const rPk = typeof r?.publicKey === 'string' ? r.publicKey : (typeof (r as any)?.pubkey === 'string' ? (r as any).pubkey : '');
            if (rPk) markReachable(rPk);
        }
        for (const m of members) {
            const pk = typeof m?.publicKey === 'string' ? m.publicKey : (typeof (m as any)?.pubkey === 'string' ? (m as any).pubkey : '');
            if (pk && !visitedInTree.has(pk)) {
                roots.push(m);
                markReachable(pk);
            }
        }

        return { tree: t, genesisRoots: roots };
    }, [members, membersMap]);

    // Branch flags computation
    const branchFlagsMap = useMemo(() => {
        const cache: Record<string, any[]> = {};
        function compute(pubkey: string, visiting = new Set<string>()): any[] {
            if (cache[pubkey]) return cache[pubkey];
            if (visiting.has(pubkey)) return [];
            visiting.add(pubkey);

            const direct = nodeFlags[pubkey] || [];
            const children = tree[pubkey] || [];
            const all = [...direct];
            for (const child of children) {
                const childPk = typeof child?.publicKey === 'string' ? child.publicKey : (typeof (child as any)?.pubkey === 'string' ? (child as any).pubkey : '');
                if (childPk) all.push(...compute(childPk, new Set(visiting)));
            }
            const unique: any[] = [];
            const seen = new Set<string>();
            for (const f of all) {
                const desc = f?.description || f?.type || '';
                if (!seen.has(desc)) {
                    seen.add(desc);
                    unique.push(f);
                }
            }
            cache[pubkey] = unique;
            return unique;
        }
        for (const m of members) {
            const pk = typeof m?.publicKey === 'string' ? m.publicKey : (typeof (m as any)?.pubkey === 'string' ? (m as any).pubkey : '');
            if (pk) compute(pk);
        }
        return cache;
    }, [members, nodeFlags, tree]);

    // Branch stats computation
    const branchStatsMap = useMemo(() => {
        const cache: Record<string, BranchStats> = {};
        function compute(pubkey: string, visiting = new Set<string>()): BranchStats {
            if (cache[pubkey]) return cache[pubkey];
            if (visiting.has(pubkey)) {
                return {
                    memberCount: 0,
                    posts: 0,
                    messages: 0,
                    deals: 0,
                    volume: 0,
                    cancelled: 0,
                };
            }
            visiting.add(pubkey);

            const rawPersonal = memberStats[pubkey] || {};
            const personal = {
                posts: typeof rawPersonal.posts === 'number' ? rawPersonal.posts : 0,
                messages: typeof rawPersonal.messages === 'number' ? rawPersonal.messages : 0,
                deals: typeof rawPersonal.deals === 'number' ? rawPersonal.deals : 0,
                volume: typeof rawPersonal.volume === 'number' ? rawPersonal.volume : 0,
                cancelled: typeof rawPersonal.cancelled === 'number' ? rawPersonal.cancelled : 0,
            };
            const children = tree[pubkey] || [];
            const agg: BranchStats = {
                memberCount: 1,
                posts: personal.posts,
                messages: personal.messages,
                deals: personal.deals,
                volume: personal.volume,
                cancelled: personal.cancelled,
            };
            for (const child of children) {
                const childPk = typeof child?.publicKey === 'string' ? child.publicKey : (typeof (child as any)?.pubkey === 'string' ? (child as any).pubkey : '');
                if (childPk) {
                    const childAgg = compute(childPk, new Set(visiting));
                    agg.memberCount += childAgg.memberCount;
                    agg.posts += childAgg.posts;
                    agg.messages += childAgg.messages;
                    agg.deals += childAgg.deals;
                    agg.volume += childAgg.volume;
                    agg.cancelled += childAgg.cancelled;
                }
            }
            agg.volume = Math.round(agg.volume * 100) / 100;
            cache[pubkey] = agg;
            return agg;
        }
        for (const m of members) {
            const pk = typeof m?.publicKey === 'string' ? m.publicKey : (typeof (m as any)?.pubkey === 'string' ? (m as any).pubkey : '');
            if (pk) compute(pk);
        }
        return cache;
    }, [members, memberStats, tree]);

    // Node matching helper
    const checkMatches = (m: MemberItem): boolean => {
        const pk = typeof m?.publicKey === 'string' ? m.publicKey : (typeof (m as any)?.pubkey === 'string' ? (m as any).pubkey : '');
        const callsign = m?.callsign != null ? String(m.callsign) : '';

        // Search match
        const q = searchQuery.trim().toLowerCase();
        const matchesSearch = !q || callsign.toLowerCase().includes(q) || pk.toLowerCase().includes(q);
        if (!matchesSearch) return false;

        // Filter match
        if (activeFilter === 'all') return true;
        if (activeFilter === 'voucher') return Boolean(m.canVouch);
        if (activeFilter === 'threats') {
            const flags = branchFlagsMap[pk] || [];
            return flags.length > 0;
        }
        if (activeFilter === 'reported') {
            const repCount = reportsByMember[pk] || 0;
            return repCount > 0;
        }
        if (activeFilter === 'frozen') {
            const standing = typeof m.standing === 'string' ? m.standing : '';
            return standing === 'FROZEN' || pk.startsWith('frozen-');
        }
        return true;
    };

    // Check if node or any of its descendants match
    const hasMatchingDescendant = (pubkey: string, visiting = new Set<string>()): boolean => {
        if (!pubkey || visiting.has(pubkey)) return false;
        visiting.add(pubkey);
        const children = tree[pubkey] || [];
        for (const child of children) {
            const childPk = typeof child?.publicKey === 'string' ? child.publicKey : (typeof (child as any)?.pubkey === 'string' ? (child as any).pubkey : '');
            if (checkMatches(child) || (childPk && hasMatchingDescendant(childPk, new Set(visiting)))) {
                return true;
            }
        }
        return false;
    };

    const matchCount = useMemo(() => {
        let count = 0;
        for (const m of members) {
            if (checkMatches(m)) count++;
        }
        return count;
    }, [members, searchQuery, activeFilter, branchFlagsMap, reportsByMember]);

    const toggleStats = (pubkey: string, e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setExpandedStats((prev) => ({
            ...prev,
            [pubkey]: !prev[pubkey],
        }));
    };

    const toggleBranch = (pubkey: string, defaultOpen: boolean) => {
        setExpandedBranches((prev) => ({
            ...prev,
            [pubkey]: !(prev[pubkey] !== undefined ? prev[pubkey] : defaultOpen),
        }));
    };

    const handleExecutePrune = async (pubkey: string) => {
        if (onPruneBranch) {
            await onPruneBranch(pubkey);
        } else {
            await pruneInviteBranch(
                activeNode.url,
                pubkey,
                activeNode.adminPassword,
                getTfaSessionToken(activeNode.id)
            );
            onRefresh?.();
        }
        setPruneTarget(null);
    };

    // Recursive node rendering
    const renderNode = (m: MemberItem, depth = 0, visiting = new Set<string>()): React.ReactNode => {
        const pk = typeof m?.publicKey === 'string' ? m.publicKey : (typeof (m as any)?.pubkey === 'string' ? (m as any).pubkey : '');
        if (!pk || visiting.has(pk)) return null;
        const nextVisiting = new Set(visiting);
        nextVisiting.add(pk);

        const callsign = m?.callsign != null ? String(m.callsign) : 'Unknown';
        const profile = profilesMap.get(pk);
        const children = tree[pk] || [];
        const hasChildren = children.length > 0;

        const isDirectMatch = checkMatches(m);
        const hasDescendantMatch = hasMatchingDescendant(pk);
        const isFilterActive = activeFilter !== 'all' || Boolean(searchQuery.trim());

        // Hide node if it doesn't match and has no matching descendants
        if (isFilterActive && !isDirectMatch && !hasDescendantMatch) {
            return null;
        }

        const isPruned = profile?.status === 'pruned';
        const standing = typeof m?.standing === 'string' ? m.standing : '';
        const isFrozen = standing === 'FROZEN' || pk.startsWith('frozen-');
        const isActive = !isPruned && !isFrozen;

        // Tier badge
        const earnedCredit = typeof m?.earnedCredit === 'number' ? m.earnedCredit : 0;
        const tierBadge = earnedCredit >= 1320 ? 'Elder'
            : earnedCredit >= 600 ? 'Steward'
            : earnedCredit >= 200 ? 'Resident'
            : 'Newcomer';

        // Badges
        const canVouch = Boolean(m?.canVouch);
        const memberReportCount = reportsByMember[pk] || 0;
        const bFlags = branchFlagsMap[pk] || [];
        const hasFlags = bFlags.length > 0;
        const isAlert = bFlags.some((f) => f?.severity === 'alert' || f?.severity === 'critical');

        // Personal stats
        const rawPersonal = memberStats[pk] || {};
        const personal = {
            posts: typeof rawPersonal.posts === 'number' ? rawPersonal.posts : 0,
            messages: typeof rawPersonal.messages === 'number' ? rawPersonal.messages : 0,
            deals: typeof rawPersonal.deals === 'number' ? rawPersonal.deals : 0,
            volume: typeof rawPersonal.volume === 'number' ? rawPersonal.volume : 0,
            cancelled: typeof rawPersonal.cancelled === 'number' ? rawPersonal.cancelled : 0,
        };

        // Branch stats
        const branchStats = branchStatsMap[pk] || {
            memberCount: 1,
            posts: personal.posts,
            messages: personal.messages,
            deals: personal.deals,
            volume: personal.volume,
            cancelled: personal.cancelled,
        };

        const isStatsOpen = Boolean(expandedStats[pk]);
        const dimStyle = isFilterActive && !isDirectMatch ? 'opacity-40' : '';

        const defaultOpen = depth < 2 || hasFlags || memberReportCount > 0;
        const effectiveDefaultOpen = isFilterActive || defaultOpen;
        const isOpen = expandedBranches[pk] !== undefined ? expandedBranches[pk] : effectiveDefaultOpen;

        return (
            <div
                key={pk}
                className={`group font-sans my-1.5 transition-all ${dimStyle}`}
                style={{ marginLeft: depth === 0 ? 0 : '14px' }}
            >
                <div
                    className={`flex items-center justify-between p-2.5 rounded-xl border bg-nature-950/70 hover:bg-nature-900/90 transition-all ${
                        isPruned
                            ? 'border-l-4 border-l-slate-600 border-nature-800'
                            : isFrozen
                                ? 'border-l-4 border-l-red-500 border-nature-800'
                                : 'border-l-4 border-l-emerald-500 border-nature-800'
                    }`}
                >
                    {/* Disclosure Trigger or Leaf Node Label */}
                    {hasChildren ? (
                        <button
                            type="button"
                            onClick={() => toggleBranch(pk, effectiveDefaultOpen)}
                            aria-expanded={isOpen}
                            aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${callsign} branch`}
                            className="flex items-center gap-2 flex-wrap min-w-0 text-left flex-1 bg-transparent border-none p-0 cursor-pointer text-inherit hover:opacity-90 focus:outline-none"
                        >
                            <span className={`text-[10px] text-nature-400 font-mono transition-transform duration-150 ${isOpen ? 'rotate-90' : ''}`}>
                                ▶
                            </span>
                            <span className="font-bold text-white text-xs">
                                {isPruned ? '🗑️ ' : isFrozen ? '⏸️ ' : ''}
                                {callsign}
                            </span>
                            <span className="font-mono text-[11px] text-nature-400">
                                ({pk.slice(0, 8)})
                            </span>

                            {/* Tier Badge */}
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-nature-800 text-nature-300 border border-nature-700">
                                {tierBadge === 'Elder' ? '⛰️ Elder' : tierBadge === 'Steward' ? '🏛️ Steward' : tierBadge === 'Resident' ? '🏠 Resident' : '🥚 Newcomer'}
                            </span>

                            {/* Voucher Pill */}
                            {canVouch && (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                                    🤝 Voucher
                                </span>
                            )}

                            {/* Health Flag Pill */}
                            {hasFlags && (
                                <span
                                    className={`px-1.5 py-0.5 rounded text-[10px] font-bold text-white ${
                                        isAlert ? 'bg-red-600' : 'bg-amber-600'
                                    }`}
                                    title={bFlags.map((f) => f?.type || '').join(', ')}
                                >
                                    {bFlags.length} ⚠️
                                </span>
                            )}

                            {/* Report Pill */}
                            {memberReportCount > 0 && (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-600 text-white">
                                    🚩 {memberReportCount}
                                </span>
                            )}

                            {/* Personal Stat Chips */}
                            <span className="hidden sm:inline-flex items-center gap-1 text-[10px] font-mono text-nature-400 ml-1">
                                {personal.posts > 0 && <span title={`${personal.posts} posts`}>📦{personal.posts}</span>}
                                {personal.messages > 0 && <span title={`${personal.messages} msgs`}>💬{personal.messages}</span>}
                                {personal.deals > 0 && <span title={`${personal.deals} deals`}>🤝{personal.deals}</span>}
                                {personal.cancelled > 0 && <span title={`${personal.cancelled} cancelled`}>🚫{personal.cancelled}</span>}
                            </span>
                        </button>
                    ) : (
                        <div className="flex items-center gap-2 flex-wrap min-w-0 text-left flex-1">
                            <span className="text-[10px] text-nature-600 font-mono invisible select-none">
                                ▶
                            </span>
                            <span className="font-bold text-white text-xs">
                                {isPruned ? '🗑️ ' : isFrozen ? '⏸️ ' : ''}
                                {callsign}
                            </span>
                            <span className="font-mono text-[11px] text-nature-400">
                                ({pk.slice(0, 8)})
                            </span>

                            {/* Tier Badge */}
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-nature-800 text-nature-300 border border-nature-700">
                                {tierBadge === 'Elder' ? '⛰️ Elder' : tierBadge === 'Steward' ? '🏛️ Steward' : tierBadge === 'Resident' ? '🏠 Resident' : '🥚 Newcomer'}
                            </span>

                            {/* Voucher Pill */}
                            {canVouch && (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                                    🤝 Voucher
                                </span>
                            )}

                            {/* Health Flag Pill */}
                            {hasFlags && (
                                <span
                                    className={`px-1.5 py-0.5 rounded text-[10px] font-bold text-white ${
                                        isAlert ? 'bg-red-600' : 'bg-amber-600'
                                    }`}
                                    title={bFlags.map((f) => f?.type || '').join(', ')}
                                >
                                    {bFlags.length} ⚠️
                                </span>
                            )}

                            {/* Report Pill */}
                            {memberReportCount > 0 && (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-600 text-white">
                                    🚩 {memberReportCount}
                                </span>
                            )}

                            {/* Personal Stat Chips */}
                            <span className="hidden sm:inline-flex items-center gap-1 text-[10px] font-mono text-nature-400 ml-1">
                                {personal.posts > 0 && <span title={`${personal.posts} posts`}>📦{personal.posts}</span>}
                                {personal.messages > 0 && <span title={`${personal.messages} msgs`}>💬{personal.messages}</span>}
                                {personal.deals > 0 && <span title={`${personal.deals} deals`}>🤝{personal.deals}</span>}
                                {personal.cancelled > 0 && <span title={`${personal.cancelled} cancelled`}>🚫{personal.cancelled}</span>}
                            </span>
                        </div>
                    )}

                    {/* Node Actions - completely separated outside disclosure button */}
                    <div className="flex items-center gap-1.5 shrink-0 ml-2" onClick={(e) => e.stopPropagation()}>
                        {/* Toggle Stats Button */}
                        <button
                            type="button"
                            onClick={(e) => toggleStats(pk, e)}
                            aria-expanded={isStatsOpen}
                            aria-controls={`stats-${pk.slice(0, 12)}`}
                            aria-label={`${isStatsOpen ? 'Hide' : 'Show'} activity stats for ${callsign}`}
                            className="min-h-[36px] px-2 py-1 rounded-lg bg-nature-900 hover:bg-nature-800 text-xs text-nature-300 border border-nature-700 transition-all"
                            title="Toggle branch activity stats"
                        >
                            📊
                        </button>

                        {/* Inspect Member */}
                        {onSelectMember && (
                            <button
                                type="button"
                                onClick={() => onSelectMember(m)}
                                className="min-h-[36px] px-2.5 py-1 rounded-lg bg-nature-900 hover:bg-nature-800 text-[11px] font-semibold text-white border border-nature-700 transition-all"
                                title="Inspect member profile"
                            >
                                👤 Inspect
                            </button>
                        )}

                        {/* Prune Branch Button */}
                        {hasChildren && !isPruned && (
                            <button
                                type="button"
                                onClick={() => setPruneTarget({ pubkey: pk, callsign })}
                                className="min-h-[36px] px-2.5 py-1 rounded-lg bg-red-950/80 hover:bg-red-900 text-[11px] font-bold text-red-200 border border-red-800/80 transition-all"
                                title="Prune this member and all descendants in their invite tree"
                            >
                                Prune Branch ({branchStats.memberCount})
                            </button>
                        )}
                    </div>
                </div>

                {/* Expandable Stats Card */}
                {isStatsOpen && (
                    <div
                        id={`stats-${pk.slice(0, 12)}`}
                        className="my-2 p-3 rounded-xl bg-nature-950 border border-nature-800 text-xs font-mono space-y-2"
                    >
                        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-nature-300">
                            <div>📦 Posts: <strong className="text-white">{personal.posts}</strong></div>
                            <div>💬 Messages: <strong className="text-white">{personal.messages}</strong></div>
                            <div>🤝 Deals: <strong className="text-white">{personal.deals}</strong></div>
                            <div>💰 Volume: <strong className="text-white">B{personal.volume}</strong></div>
                            <div>🚫 Cancelled: <strong className="text-white">{personal.cancelled}</strong></div>
                        </div>
                        {hasChildren && (
                            <div className="p-2 rounded bg-nature-900 border border-sky-900/60 text-sky-300 flex flex-wrap gap-3">
                                <span>🌳 <strong>Branch ({branchStats.memberCount} members)</strong>:</span>
                                <span>📦 {branchStats.posts} posts</span>
                                <span>💬 {branchStats.messages} msgs</span>
                                <span>🤝 {branchStats.deals} deals</span>
                                <span>💰 B{branchStats.volume} volume</span>
                                <span>🚫 {branchStats.cancelled} cancelled</span>
                            </div>
                        )}
                    </div>
                )}

                {/* Children Recursive Container */}
                {hasChildren && isOpen && (
                    <div className="pl-2 border-l border-nature-800/80 mt-1">
                        {children.map((c) => renderNode(c, depth + 1, nextVisiting))}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="p-4 sm:p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-6 font-sans">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-nature-800 pb-4">
                <div>
                    <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                        <span>🌳</span>
                        <span>Hierarchical Ancestry Tree &amp; Lineage Audit</span>
                    </h3>
                    <p className="text-xs text-nature-400 m-0 mt-0.5">
                        Trace multi-hop invitation lineage from genesis, inspect aggregate branch activity, and prune abusive invite trees.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={onRefresh}
                    disabled={nodeDataLoading}
                    className="min-h-[44px] px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all flex items-center gap-2 self-start sm:self-auto disabled:opacity-50"
                >
                    <span className={nodeDataLoading ? 'animate-spin' : ''}>🔄</span>
                    <span>{nodeDataLoading ? 'Refreshing...' : 'Refresh Tree'}</span>
                </button>
            </div>

            {/* Search & Audit Filter Controls */}
            <div className="space-y-3">
                <div id="member-search-row" className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                    <div className="relative flex-1">
                        <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-nature-500 text-xs pointer-events-none">
                            🔍
                        </span>
                        <input
                            id="member-search"
                            type="search"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Search members by callsign or pubkey..."
                            className="w-full bg-nature-950 border border-nature-700 rounded-xl pl-9 pr-8 py-2 text-xs text-white font-mono focus:outline-none focus:border-terra-500"
                        />
                        {searchQuery && (
                            <button
                                id="member-search-clear"
                                type="button"
                                onClick={() => setSearchQuery('')}
                                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-nature-400 hover:text-white p-1 text-xs"
                                title="Clear search"
                            >
                                ✕
                            </button>
                        )}
                    </div>
                    <span id="member-result-count" className="text-xs text-nature-400 font-mono whitespace-nowrap self-center">
                        Showing {matchCount} of {members.length} members
                    </span>
                </div>

                {/* Filter buttons */}
                <div id="audit-filter-bar" className="flex items-center gap-1.5 flex-wrap pt-1">
                    <button
                        type="button"
                        data-filter="all"
                        onClick={() => setActiveFilter('all')}
                        className={`audit-filter-btn min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                            activeFilter === 'all'
                                ? 'bg-nature-700 text-white border-nature-500'
                                : 'bg-nature-950 text-nature-400 hover:text-white border-nature-800'
                        }`}
                    >
                        All
                    </button>
                    <button
                        type="button"
                        data-filter="voucher"
                        onClick={() => setActiveFilter('voucher')}
                        className={`audit-filter-btn min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                            activeFilter === 'voucher'
                                ? 'bg-emerald-950 text-emerald-300 border-emerald-500'
                                : 'bg-nature-950 text-nature-400 hover:text-emerald-300 border-nature-800'
                        }`}
                    >
                        🤝 Vouchers
                    </button>
                    <button
                        type="button"
                        data-filter="threats"
                        onClick={() => setActiveFilter('threats')}
                        className={`audit-filter-btn min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                            activeFilter === 'threats'
                                ? 'bg-amber-950 text-amber-300 border-amber-500'
                                : 'bg-nature-950 text-nature-400 hover:text-amber-300 border-nature-800'
                        }`}
                    >
                        ⚠️ Threats
                    </button>
                    <button
                        type="button"
                        data-filter="reported"
                        onClick={() => setActiveFilter('reported')}
                        className={`audit-filter-btn min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                            activeFilter === 'reported'
                                ? 'bg-red-950 text-red-300 border-red-500'
                                : 'bg-nature-950 text-nature-400 hover:text-red-300 border-nature-800'
                        }`}
                    >
                        🚩 Reported
                    </button>
                    <button
                        type="button"
                        data-filter="frozen"
                        onClick={() => setActiveFilter('frozen')}
                        className={`audit-filter-btn min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                            activeFilter === 'frozen'
                                ? 'bg-purple-950 text-purple-300 border-purple-500'
                                : 'bg-nature-950 text-nature-400 hover:text-purple-300 border-nature-800'
                        }`}
                    >
                        ⏸️ Frozen
                    </button>
                </div>
            </div>

            {/* Tree Viewport */}
            <div
                id="admin-members-tree"
                className="max-h-[640px] overflow-y-auto border border-nature-800 rounded-xl p-3 bg-black/40 space-y-1"
            >
                {genesisRoots.length === 0 ? (
                    <div className="p-8 text-center text-nature-500 text-xs font-mono">
                        No members found in directory
                    </div>
                ) : matchCount === 0 ? (
                    <div className="p-8 text-center text-nature-400 text-xs">
                        No members match {searchQuery ? `"${searchQuery}"` : 'this filter'}.
                    </div>
                ) : (
                    genesisRoots.map((root) => renderNode(root, 0))
                )}
            </div>

            {/* Safeguard Prune Branch Modal */}
            {pruneTarget && (
                <PruneBranchModal
                    rootMember={membersMap.get(pruneTarget.pubkey) || {
                        publicKey: pruneTarget.pubkey,
                        pubkey: pruneTarget.pubkey,
                        callsign: pruneTarget.callsign,
                    }}
                    members={members}
                    accounts={accounts}
                    onClose={() => setPruneTarget(null)}
                    onConfirm={handleExecutePrune}
                />
            )}
        </div>
    );
}
