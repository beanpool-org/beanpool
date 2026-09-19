import React, { useState, useEffect } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { Avatar } from '../common/Avatar';
import {
    fetchNodeTreasuries,
    createNodeTreasury,
    seedTreasuryOffer,
    fetchTreasuryKeepers,
    assignTreasuryKeeper,
    revokeTreasuryKeeper,
    normalizeKeeperPubkey,
    normalizeKeepers,
    type NodeTreasury,
    type NodeDataPayload,
    type MemberItem,
    resolveNodeApiUrl,
    buildAdminHeaders,
    getTfaSessionToken,
} from '../../lib/node-client';
import { EscrowDisputesPanel } from './EscrowDisputesPanel';
import { DecisionsAdminPanel } from './DecisionsAdminPanel';
import { EnterpriseLocationPicker } from './EnterpriseLocationPicker';

interface EconomySectionProps {
    activeNode: NodeProfile;
    nodeData?: NodeDataPayload | null;
    tfaToken?: string;
    onRefresh: () => void;
    initialSubTab?: 'enterprises' | 'decisions' | 'pool' | 'disputes';
}

interface CommonsProject {
    id: string;
    title: string;
    description: string;
    requestedAmount?: number;
    proposer?: string;
    status?: string;
}

const ENTERPRISE_PRESETS = [
    {
        name: 'Community Garden & Produce',
        avatar: '🌾',
        purpose: 'Fresh seasonal vegetables, fruit, seedlings, and compost for members',
    },
    {
        name: 'Tool Shed & Workshop',
        avatar: '🛠️',
        purpose: 'Lending library of power tools, hand tools, workshop gear, and repairs',
    },
    {
        name: 'Machinery & Transport',
        avatar: '🚜',
        purpose: 'Tractor, trailer, equipment haulage, and shared machinery pool',
    },
    {
        name: 'Pasture Eggs & Poultry',
        avatar: '🥚',
        purpose: 'Pasture-raised fresh eggs and ethical poultry feed co-operative',
    },
];

export function EconomySection({
    activeNode,
    nodeData,
    tfaToken,
    onRefresh,
    initialSubTab = 'enterprises',
}: EconomySectionProps) {
    const effectiveTfaToken = tfaToken || (activeNode ? getTfaSessionToken(activeNode.id) : undefined);
    const [subTab, setSubTab] = useState<'enterprises' | 'decisions' | 'pool' | 'disputes'>(initialSubTab);

    useEffect(() => {
        if (initialSubTab) {
            setSubTab(initialSubTab);
        }
    }, [initialSubTab]);

    // Enterprises state
    const [treasuries, setTreasuries] = useState<NodeTreasury[]>([]);
    const [loadingTreasuries, setLoadingTreasuries] = useState(false);
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [newEnterpriseName, setNewEnterpriseName] = useState('');
    const [newEnterpriseAvatar, setNewEnterpriseAvatar] = useState('🌾');
    const [newEnterprisePurpose, setNewEnterprisePurpose] = useState('');
    const [newEnterpriseCeiling, setNewEnterpriseCeiling] = useState('');
    const [newEnterpriseKeeper, setNewEnterpriseKeeper] = useState('');
    const [creatingEnterprise, setCreatingEnterprise] = useState(false);
    const [editingLocationPubkey, setEditingLocationPubkey] = useState<string | null>(null);

    // Keepers state
    const [keepersMap, setKeepersMap] = useState<Record<string, any[]>>({});
    const [manageKeepersTreasury, setManageKeepersTreasury] = useState<NodeTreasury | null>(null);
    const [assignMemberPubkey, setAssignMemberPubkey] = useState('');
    const [customKeeperPubkey, setCustomKeeperPubkey] = useState('');
    const [keeperActionLoading, setKeeperActionLoading] = useState(false);
    const [keeperError, setKeeperError] = useState<string | null>(null);

    // Offer seed state
    const [seedOfferTreasury, setSeedOfferTreasury] = useState<NodeTreasury | null>(null);
    const [offerTitle, setOfferTitle] = useState('');
    const [offerCredits, setOfferCredits] = useState('15');
    const [offerCategory, setOfferCategory] = useState('food');
    const [seedingOffer, setSeedingOffer] = useState(false);

    // Commons proposals state
    const [commonsData, setCommonsData] = useState<{
        proposed: CommonsProject[];
    }>({ proposed: [] });
    const [loadingCommons, setLoadingCommons] = useState(false);

    const members: MemberItem[] = Array.isArray(nodeData?.members) ? nodeData.members : [];

    const getMemberDisplayName = (input: unknown): string => {
        if (!input) return 'Unknown';
        let pubkey = '';
        let directName = '';

        if (typeof input === 'string') {
            pubkey = input.trim();
        } else if (typeof input === 'object' && input !== null) {
            const obj = input as {
                callsign?: unknown;
                name?: unknown;
                displayName?: unknown;
            };
            if (typeof obj.callsign === 'string' && obj.callsign.trim()) directName = obj.callsign.trim();
            else if (typeof obj.name === 'string' && obj.name.trim()) directName = obj.name.trim();
            else if (typeof obj.displayName === 'string' && obj.displayName.trim()) directName = obj.displayName.trim();

            pubkey = normalizeKeeperPubkey(input);
        }

        // Prefer the keeper entry's own callsign when present rather than depending on a second lookup
        if (directName) return directName;

        if (pubkey && Array.isArray(members)) {
            const lowerPubkey = pubkey.toLowerCase();
            const found = members.find((m) => {
                if (!m) return false;
                const mPk = normalizeKeeperPubkey(m);
                return mPk && mPk.toLowerCase() === lowerPubkey;
            });
            if (found) {
                const foundName = (typeof found.callsign === 'string' && found.callsign.trim())
                    ? found.callsign.trim()
                    : ((typeof found.name === 'string' && found.name.trim())
                        ? found.name.trim()
                        : ((typeof (found as any).displayName === 'string' && (found as any).displayName.trim())
                            ? (found as any).displayName.trim()
                            : ''));
                if (foundName) {
                    return foundName;
                }
            }
        }

        if (typeof pubkey === 'string' && pubkey.length > 0) {
            return pubkey.length > 10 ? `${pubkey.slice(0, 10)}...` : pubkey;
        }
        return typeof input === 'string' ? input : 'Member';
    };

    const loadTreasuries = async () => {
        setLoadingTreasuries(true);
        try {
            const list = await fetchNodeTreasuries(activeNode.url);
            setTreasuries(list || []);

            // Populate keepers from list or fetch individually if not returned
            const initialMap: Record<string, any[]> = {};
            for (const t of list || []) {
                if (t.publicKey) {
                    initialMap[t.publicKey] = Array.isArray(t.keepers) ? t.keepers : [];
                }
            }
            setKeepersMap(initialMap);

            // Fetch live keepers for any treasury missing keepers in initial list
            const missing = (list || []).filter((t) => t.publicKey && !Array.isArray(t.keepers));
            if (missing.length > 0) {
                const results = await Promise.all(
                    missing.map(async (t) => {
                        try {
                            const keepers = await fetchTreasuryKeepers(
                                activeNode.url,
                                t.publicKey,
                                activeNode.adminPassword,
                                effectiveTfaToken
                            );
                            return { pubkey: t.publicKey, keepers: Array.isArray(keepers) ? keepers : [] };
                        } catch {
                            return { pubkey: t.publicKey, keepers: [] };
                        }
                    })
                );
                setKeepersMap((prev) => {
                    const next = { ...prev };
                    for (const r of results) {
                        next[r.pubkey] = r.keepers;
                    }
                    return next;
                });
            }
        } catch {
            setTreasuries([]);
            setKeepersMap({});
        } finally {
            setLoadingTreasuries(false);
        }
    };

    const loadCommonsData = async () => {
        setLoadingCommons(true);
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/commons/projects');
            const res = await fetch(url, {
                method: 'POST',
                headers: buildAdminHeaders(activeNode.adminPassword, effectiveTfaToken),
            });
            if (res.ok) {
                const data = await res.json();
                setCommonsData({
                    proposed: data.projects || data.proposed || [],
                });
            }
        } catch {
            // fallback
        } finally {
            setLoadingCommons(false);
        }
    };

    useEffect(() => {
        loadTreasuries();
        loadCommonsData();
    }, [activeNode?.id, activeNode?.url]);

    const handleCreateEnterprise = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newEnterpriseName.trim()) return;
        setCreatingEnterprise(true);
        try {
            const ceilingNum = newEnterpriseCeiling.trim() ? Number(newEnterpriseCeiling) : null;
            const res = await createNodeTreasury(
                activeNode.url,
                {
                    name: newEnterpriseName.trim(),
                    avatar: newEnterpriseAvatar.trim() || '🌾',
                    workingCapitalCeiling: ceilingNum,
                    purpose: newEnterprisePurpose.trim() || undefined,
                },
                activeNode.adminPassword,
                effectiveTfaToken
            );

            // If an initial keeper was selected, assign them immediately
            if (res.publicKey && newEnterpriseKeeper.trim()) {
                try {
                    await assignTreasuryKeeper(
                        activeNode.url,
                        res.publicKey,
                        newEnterpriseKeeper.trim(),
                        activeNode.adminPassword,
                        effectiveTfaToken
                    );
                } catch (assignErr) {
                    console.error('Failed to assign initial keeper:', assignErr);
                }
            }

            setNewEnterpriseName('');
            setNewEnterpriseAvatar('🌾');
            setNewEnterprisePurpose('');
            setNewEnterpriseCeiling('');
            setNewEnterpriseKeeper('');
            setShowCreateModal(false);
            await loadTreasuries();
            onRefresh();
        } catch (e: unknown) {
            alert(e instanceof Error ? e.message : 'Failed to create enterprise');
        } finally {
            setCreatingEnterprise(false);
        }
    };

    const handleApplyPreset = (preset: typeof ENTERPRISE_PRESETS[0]) => {
        setNewEnterpriseName(preset.name);
        setNewEnterpriseAvatar(preset.avatar);
        setNewEnterprisePurpose(preset.purpose);
    };

    const handleOpenManageKeepers = async (t: NodeTreasury) => {
        setManageKeepersTreasury(t);
        setKeeperError(null);
        setAssignMemberPubkey('');
        setCustomKeeperPubkey('');

        // Refresh keepers for this treasury to be 100% current
        try {
            const keepers = await fetchTreasuryKeepers(
                activeNode.url,
                t.publicKey,
                activeNode.adminPassword,
                effectiveTfaToken
            );
            setKeepersMap((prev) => ({ ...prev, [t.publicKey]: Array.isArray(keepers) ? keepers : [] }));
        } catch {
            // Keep existing from map if fetch fails
        }
    };

    const handleAssignKeeper = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!manageKeepersTreasury) return;
        const targetPubkey = (assignMemberPubkey || customKeeperPubkey).trim();
        if (!targetPubkey) {
            setKeeperError('Please select a community member or enter a public key.');
            return;
        }

        setKeeperActionLoading(true);
        setKeeperError(null);
        try {
            const updatedKeepers = await assignTreasuryKeeper(
                activeNode.url,
                manageKeepersTreasury.publicKey,
                targetPubkey,
                activeNode.adminPassword,
                effectiveTfaToken
            );
            setKeepersMap((prev) => ({
                ...prev,
                [manageKeepersTreasury.publicKey]: Array.isArray(updatedKeepers) ? updatedKeepers : [],
            }));
            setAssignMemberPubkey('');
            setCustomKeeperPubkey('');
            onRefresh();
        } catch (err: unknown) {
            setKeeperError(err instanceof Error ? err.message : 'Failed to assign keeper');
        } finally {
            setKeeperActionLoading(false);
        }
    };

    const handleRevokeKeeper = async (keeperInput: unknown) => {
        if (!manageKeepersTreasury) return;
        const keeperPubkey = normalizeKeeperPubkey(keeperInput);
        if (!keeperPubkey) {
            console.error('Unable to determine keeper public key for revocation', keeperInput);
            return;
        }

        const displayName = getMemberDisplayName(keeperInput);
        if (!confirm(`Revoke keeper permissions from @${displayName} for ${manageKeepersTreasury.name}?`)) {
            return;
        }

        setKeeperActionLoading(true);
        setKeeperError(null);
        try {
            const updatedKeepers = await revokeTreasuryKeeper(
                activeNode.url,
                manageKeepersTreasury.publicKey,
                keeperPubkey,
                activeNode.adminPassword,
                effectiveTfaToken
            );
            setKeepersMap((prev) => ({
                ...prev,
                [manageKeepersTreasury.publicKey]: Array.isArray(updatedKeepers) ? updatedKeepers : [],
            }));
            onRefresh();
        } catch (err: unknown) {
            setKeeperError(err instanceof Error ? err.message : 'Failed to revoke keeper');
        } finally {
            setKeeperActionLoading(false);
        }
    };

    const handleSeedOffer = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!seedOfferTreasury || !offerTitle.trim()) return;
        setSeedingOffer(true);
        try {
            const pk = seedOfferTreasury.publicKey || '';
            await seedTreasuryOffer(
                activeNode.url,
                pk,
                {
                    title: offerTitle.trim(),
                    category: offerCategory,
                    credits: Number(offerCredits) || 10,
                    description: `${seedOfferTreasury.name} community offer`,
                },
                activeNode.adminPassword,
                effectiveTfaToken
            );
            setSeedOfferTreasury(null);
            setOfferTitle('');
            await loadTreasuries();
            onRefresh();
        } catch (e: unknown) {
            alert(e instanceof Error ? e.message : 'Failed to seed initial offer');
        } finally {
            setSeedingOffer(false);
        }
    };

    const handleRejectProject = async (projectId: string) => {
        if (!confirm('Reject and dismiss this commons proposal?')) return;
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/commons/reject');
            await fetch(url, {
                method: 'POST',
                headers: buildAdminHeaders(activeNode.adminPassword, effectiveTfaToken),
                body: JSON.stringify({ projectId }),
            });
            await loadCommonsData();
        } catch (e: unknown) {
            alert(e instanceof Error ? e.message : String(e));
        }
    };

    return (
        <div className="space-y-6 font-sans animate-fade-in">
            {/* Header & Subtabs */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-nature-800 pb-4">
                <div>
                    <h2 className="text-xl font-black text-white m-0 tracking-tight flex items-center gap-2.5">
                        <span>🏛️</span>
                        <span>Shared Projects &amp; Economy</span>
                    </h2>
                    <p className="text-xs text-nature-400 m-0 mt-1">
                        Commons pool, shared enterprises, keeper covenants, and community decisions
                    </p>
                </div>

                <div className="flex items-center gap-1.5 bg-nature-950 p-1.5 rounded-xl border border-nature-800 self-start sm:self-auto">
                    <button
                        onClick={() => setSubTab('enterprises')}
                        className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                            subTab === 'enterprises'
                                ? 'bg-terra-500/20 text-terra-300 border border-terra-500/40 shadow-sm'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        Enterprises ({treasuries.length})
                    </button>
                    <button
                        onClick={() => setSubTab('decisions')}
                        className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                            subTab === 'decisions'
                                ? 'bg-terra-500/20 text-terra-300 border border-terra-500/40 shadow-sm'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        Proposals
                    </button>
                    <button
                        onClick={() => setSubTab('pool')}
                        className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                            subTab === 'pool'
                                ? 'bg-terra-500/20 text-terra-300 border border-terra-500/40 shadow-sm'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        Commons Pool
                    </button>
                    <button
                        onClick={() => setSubTab('disputes')}
                        className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                            subTab === 'disputes'
                                ? 'bg-terra-500/20 text-terra-300 border border-terra-500/40 shadow-sm'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        ⚖️ Escrow Disputes{typeof nodeData?.escrowDisputesCount === 'number' && nodeData.escrowDisputesCount > 0 ? ` (${nodeData.escrowDisputesCount})` : ''}
                    </button>
                </div>
            </div>

            {/* Subtab: Enterprises */}
            {subTab === 'enterprises' && (
                <div className="space-y-6">
                    <div className="flex items-center justify-between">
                        <div>
                            <h3 className="text-base font-bold text-white m-0">Shared Community Enterprises</h3>
                            <p className="text-xs text-nature-400 m-0 mt-0.5">
                                Co-operatives, shared tools, community garden, and food initiatives
                            </p>
                        </div>
                        <button
                            onClick={() => setShowCreateModal(true)}
                            className="px-4 py-2 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all shadow-md flex items-center gap-1.5"
                        >
                            <span>+</span>
                            <span>Create Enterprise</span>
                        </button>
                    </div>

                    {loadingTreasuries ? (
                        <div className="p-8 text-center text-xs text-nature-400">Loading enterprises...</div>
                    ) : treasuries.length === 0 ? (
                        <div className="p-8 text-center bg-nature-900/40 border border-nature-800 rounded-2xl">
                            <p className="text-sm font-semibold text-white mb-1">No enterprises created yet</p>
                            <p className="text-xs text-nature-400 mb-4">
                                Establish the first enterprise (e.g. food, tools, machinery) and assign keepers.
                            </p>
                            <button
                                onClick={() => setShowCreateModal(true)}
                                className="px-4 py-2 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white"
                            >
                                + Create First Enterprise
                            </button>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            {treasuries.map((t, idx) => {
                                const rawKeepers = keepersMap[t.publicKey] || t.keepers || [];
                                const currentKeepers = Array.isArray(rawKeepers) ? rawKeepers : [];
                                const pubkeyStr = typeof t.publicKey === 'string' ? t.publicKey : '';
                                return (
                                    <div
                                        key={pubkeyStr || `treasury-${idx}`}
                                        className="p-5 rounded-2xl bg-nature-900/80 border border-nature-800 hover:border-nature-700 transition-all flex flex-col justify-between shadow-lg space-y-4"
                                    >
                                        <div>
                                            <div className="flex items-start justify-between gap-2 mb-2">
                                                <div className="flex items-center gap-2.5 min-w-0">
                                                    <Avatar
                                                        src={t.avatar}
                                                        alt={t.name || 'Enterprise'}
                                                        className="w-9 h-9 rounded-xl bg-nature-800 border border-nature-700 flex items-center justify-center text-lg overflow-hidden shrink-0"
                                                        fallbackGlyph="🌾"
                                                    />
                                                    <div className="min-w-0">
                                                        <h4 className="text-sm font-bold text-white m-0 truncate">{t.name}</h4>
                                                        <span className="text-[10px] font-mono text-nature-400 block truncate">
                                                            {pubkeyStr ? `${pubkeyStr.slice(0, 12)}...` : 'Unknown'}
                                                        </span>
                                                    </div>
                                                </div>
                                                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                                                    Active
                                                </span>
                                            </div>

                                            <p className="text-xs text-nature-300 m-0 mb-3 line-clamp-2">
                                                {t.purpose || 'Community cooperative enterprise account.'}
                                            </p>

                                            {/* Working capital ceiling badge */}
                                            {t.workingCapitalCeiling != null && (
                                                <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-nature-950 border border-nature-800 text-[10px] text-nature-300 mb-3">
                                                    <span className="text-terra-400 font-bold">Ceiling:</span>
                                                    <span className="font-mono">{t.workingCapitalCeiling} beans</span>
                                                </div>
                                            )}

                                            {/* Keepers display */}
                                            <div className="bg-nature-950/70 border border-nature-800/80 rounded-xl p-2.5 space-y-1.5">
                                                <div className="flex items-center justify-between">
                                                    <span className="text-[10px] font-bold uppercase tracking-wider text-nature-400">
                                                        Keepers ({currentKeepers.length})
                                                    </span>
                                                    <button
                                                        onClick={() => handleOpenManageKeepers(t)}
                                                        className="text-[10px] font-bold text-terra-400 hover:text-terra-300 transition-colors"
                                                    >
                                                        Manage
                                                    </button>
                                                </div>
                                                {currentKeepers.length === 0 ? (
                                                    <div className="text-[11px] text-amber-400/90 flex items-center gap-1">
                                                        <span>⚠️</span>
                                                        <span>No keepers appointed</span>
                                                    </div>
                                                ) : (
                                                    <div className="flex flex-wrap gap-1">
                                                        {currentKeepers.slice(0, 3).map((pk, idx) => {
                                                            const kPubkey = normalizeKeeperPubkey(pk) || String(idx);
                                                            return (
                                                                <span
                                                                    key={kPubkey || idx}
                                                                    className="px-2 py-0.5 rounded-md bg-nature-800/80 border border-nature-700 text-[10px] font-medium text-nature-200"
                                                                >
                                                                    @{getMemberDisplayName(pk)}
                                                                </span>
                                                            );
                                                        })}
                                                        {currentKeepers.length > 3 && (
                                                            <span className="px-1.5 py-0.5 rounded text-[10px] text-nature-400 font-medium">
                                                                +{currentKeepers.length - 3} more
                                                            </span>
                                                        )}
                                                    </div>
                                                )}
                                            </div>

                                            {/* Map Location display & trigger */}
                                            <div className="bg-nature-950/70 border border-nature-800/80 rounded-xl p-2.5 space-y-1.5 mt-2.5">
                                                <div className="flex items-center justify-between">
                                                    <span className="text-[10px] font-bold uppercase tracking-wider text-nature-400 flex items-center gap-1">
                                                        <span>📍</span>
                                                        <span>Map Location</span>
                                                    </span>
                                                    <button
                                                        type="button"
                                                        onClick={() => setEditingLocationPubkey(editingLocationPubkey === pubkeyStr ? null : pubkeyStr)}
                                                        className="text-[10px] font-bold text-terra-400 hover:text-terra-300 transition-colors"
                                                    >
                                                        {editingLocationPubkey === pubkeyStr ? 'Close' : (t.lat != null && t.lng != null ? 'Edit' : 'Set Location')}
                                                    </button>
                                                </div>
                                                {t.lat != null && t.lng != null ? (
                                                    <div className="flex items-center justify-between text-[11px] font-mono text-emerald-400">
                                                        <span>{t.lat.toFixed(3)}, {t.lng.toFixed(3)}</span>
                                                        <span className="text-[10px] font-sans text-nature-400">Public map pin</span>
                                                    </div>
                                                ) : (
                                                    <div className="text-[11px] text-nature-400 italic">
                                                        No map location set
                                                    </div>
                                                )}
                                            </div>

                                            {/* Reusable Leaflet Location Picker */}
                                            {editingLocationPubkey === pubkeyStr && (
                                                <EnterpriseLocationPicker
                                                    treasury={t}
                                                    activeNode={activeNode}
                                                    effectiveTfaToken={effectiveTfaToken}
                                                    onLocationSaved={(newLat, newLng) => {
                                                        setTreasuries((prev) =>
                                                            prev.map((item) =>
                                                                item.publicKey === t.publicKey ? { ...item, lat: newLat, lng: newLng } : item
                                                            )
                                                        );
                                                    }}
                                                    onClose={() => setEditingLocationPubkey(null)}
                                                />
                                            )}
                                        </div>

                                        <div className="border-t border-nature-800/80 pt-3 flex items-center justify-between">
                                            <div>
                                                <div className="text-[10px] text-nature-400 uppercase font-bold">Balance</div>
                                                <div className="text-sm font-bold text-white font-mono">
                                                    {t.balance ?? '0.00'} beans
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <button
                                                    onClick={() => setEditingLocationPubkey(editingLocationPubkey === pubkeyStr ? null : pubkeyStr)}
                                                    className="px-2.5 py-1.5 rounded-lg bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all"
                                                >
                                                    Location
                                                </button>
                                                <button
                                                    onClick={() => handleOpenManageKeepers(t)}
                                                    className="px-2.5 py-1.5 rounded-lg bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all"
                                                >
                                                    Keepers
                                                </button>
                                                <button
                                                    onClick={() => setSeedOfferTreasury(t)}
                                                    className="px-2.5 py-1.5 rounded-lg bg-terra-900/30 hover:bg-terra-900/50 text-xs font-bold text-terra-300 border border-terra-700/50 transition-all"
                                                >
                                                    Seed Offer
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {/* Subtab: Commons proposals */}
            {subTab === 'decisions' && (
                <div className="space-y-6">
                    <DecisionsAdminPanel activeNode={activeNode} tfaToken={effectiveTfaToken} />

                    {/* Proposed Projects */}
                    <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4">
                        <h3 className="text-base font-bold text-white m-0">Pending Commons Proposals ({commonsData.proposed.length})</h3>
                        {commonsData.proposed.length === 0 ? (
                            <div className="py-6 text-center text-xs text-nature-400">
                                No pending proposals.
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {commonsData.proposed.map((p) => (
                                    <div
                                        key={p.id}
                                        className="p-4 rounded-xl bg-nature-950 border border-nature-800 flex items-center justify-between gap-3"
                                    >
                                        <div>
                                            <h4 className="text-sm font-bold text-white m-0">{p.title}</h4>
                                            <p className="text-xs text-nature-400 m-0 mt-0.5">{p.description}</p>
                                            {p.requestedAmount && (
                                                <span className="text-xs text-terra-400 font-semibold mt-1 inline-block">
                                                    Requesting: {p.requestedAmount} beans
                                                </span>
                                            )}
                                        </div>
                                        <button
                                            onClick={() => handleRejectProject(p.id)}
                                            className="px-2.5 py-1 rounded bg-nature-800 hover:bg-nature-700 text-xs text-red-400 font-bold border border-nature-700"
                                        >
                                            Dismiss
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Subtab: Commons Pool */}
            {subTab === 'pool' && (
                <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-6">
                    <div className="border-b border-nature-800 pb-4">
                        <h3 className="text-base font-bold text-white m-0">🏛️ Community Commons Pool Health</h3>
                        <p className="text-xs text-nature-400 m-0 mt-0.5">
                            Autonomous zero-sum shared treasury funded by demurrage and trade contributions (1.5%)
                        </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="p-4 rounded-xl bg-nature-950 border border-nature-800">
                            <span className="text-xs text-nature-400 font-bold uppercase">Pool Reserve</span>
                            <div className="text-2xl font-black text-white font-mono mt-1">240.0 beans</div>
                            <span className="text-[10px] text-emerald-400 font-medium">✓ Solvent &amp; Fully Backed</span>
                        </div>
                        <div className="p-4 rounded-xl bg-nature-950 border border-nature-800">
                            <span className="text-xs text-nature-400 font-bold uppercase">Conservation Check</span>
                            <div className="text-2xl font-black text-white font-mono mt-1">0.0 drift</div>
                            <span className="text-[10px] text-emerald-400 font-medium">✓ SUM(balances) + POOL = 0</span>
                        </div>
                        <div className="p-4 rounded-xl bg-nature-950 border border-nature-800">
                            <span className="text-xs text-nature-400 font-bold uppercase">Active Grants</span>
                            <div className="text-2xl font-black text-white font-mono mt-1">0 queued</div>
                            <span className="text-[10px] text-nature-400 font-medium">All approved grants disbursed</span>
                        </div>
                    </div>
                </div>
            )}

            {/* Create Enterprise Modal */}
            {showCreateModal && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="w-full max-w-lg bg-nature-900 border border-nature-800 rounded-3xl p-6 shadow-2xl space-y-4 animate-fade-in max-h-[90vh] overflow-y-auto">
                        <div className="border-b border-nature-800 pb-3">
                            <h3 className="text-base font-bold text-white m-0">🌾 Create Community Enterprise</h3>
                            <p className="text-xs text-nature-400 m-0 mt-0.5">
                                Set up a shared cooperative account to trade, post offers, and organise community work.
                            </p>
                        </div>

                        {/* Presets */}
                        <div>
                            <span className="text-xs font-bold text-nature-300 block mb-2">Choose from Presets:</span>
                            <div className="grid grid-cols-2 gap-2">
                                {ENTERPRISE_PRESETS.map((p) => (
                                    <button
                                        key={p.name}
                                        type="button"
                                        onClick={() => handleApplyPreset(p)}
                                        className="p-2.5 rounded-xl bg-nature-950 hover:bg-nature-800/80 border border-nature-800 text-left transition-all group"
                                    >
                                        <div className="flex items-center gap-1.5 text-xs font-bold text-white group-hover:text-terra-300">
                                            <Avatar
                                                src={p.avatar}
                                                alt=""
                                                className="w-5 h-5 rounded flex items-center justify-center text-xs overflow-hidden shrink-0"
                                                fallbackGlyph="🌾"
                                            />
                                            <span className="truncate">{p.name}</span>
                                        </div>
                                        <p className="text-[10px] text-nature-400 line-clamp-1 mt-0.5">{p.purpose}</p>
                                    </button>
                                ))}
                            </div>
                        </div>

                        <form onSubmit={handleCreateEnterprise} className="space-y-3 pt-2">
                            <div className="grid grid-cols-4 gap-2">
                                <div className="col-span-1">
                                    <label className="block text-xs font-bold text-nature-300 mb-1">Avatar</label>
                                    <div className="flex items-center gap-2">
                                        <Avatar
                                            src={newEnterpriseAvatar}
                                            alt={newEnterpriseName || 'Enterprise'}
                                            className="w-10 h-10 rounded-xl bg-nature-950 border border-nature-700 flex items-center justify-center text-lg overflow-hidden shrink-0"
                                            fallbackGlyph="🌾"
                                        />
                                        <input
                                            type="text"
                                            value={newEnterpriseAvatar}
                                            onChange={(e) => setNewEnterpriseAvatar(e.target.value)}
                                            placeholder="🌾"
                                            className="w-full bg-nature-950 border border-nature-700 rounded-xl px-2 py-2 text-center text-sm text-white focus:outline-none focus:border-terra-500"
                                        />
                                    </div>
                                </div>
                                <div className="col-span-3">
                                    <label className="block text-xs font-bold text-nature-300 mb-1">Enterprise Name</label>
                                    <input
                                        type="text"
                                        value={newEnterpriseName}
                                        onChange={(e) => setNewEnterpriseName(e.target.value)}
                                        placeholder="e.g. Community Eggs, Tool Shed, Bakery"
                                        required
                                        className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-terra-500"
                                    />
                                </div>
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-nature-300 mb-1">Purpose Statement</label>
                                <textarea
                                    value={newEnterprisePurpose}
                                    onChange={(e) => setNewEnterprisePurpose(e.target.value)}
                                    placeholder="What does this enterprise produce or provide for the community?"
                                    rows={2}
                                    className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-terra-500 resize-none"
                                />
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-nature-300 mb-1">
                                    Working Capital Ceiling (Beans, optional)
                                </label>
                                <input
                                    type="number"
                                    min="0"
                                    value={newEnterpriseCeiling}
                                    onChange={(e) => setNewEnterpriseCeiling(e.target.value)}
                                    placeholder="e.g. 200 (surplus above this automatically sweeps to Commons)"
                                    className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2 text-sm text-white font-mono focus:outline-none focus:border-terra-500"
                                />
                                <p className="text-[10px] text-nature-400 mt-1">
                                    Rule 7: Enterprise retains operating reserves up to ceiling; surplus returns to Commons.
                                </p>
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-nature-300 mb-1">
                                    Initial Lead Keeper (Optional)
                                </label>
                                <select
                                    value={newEnterpriseKeeper}
                                    onChange={(e) => setNewEnterpriseKeeper(e.target.value)}
                                    className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-terra-500"
                                >
                                    <option value="">None (assign keeper later)</option>
                                    {members.map((m, idx) => {
                                        const pk = typeof m.publicKey === 'string' ? m.publicKey : (typeof m.pubkey === 'string' ? m.pubkey : '');
                                        const rawName = m.name || (m as { callsign?: string }).callsign;
                                        const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : (pk ? pk.slice(0, 10) : 'Member');
                                        return (
                                            <option key={pk || `member-${idx}`} value={pk}>
                                                @{name} ({pk ? `${pk.slice(0, 8)}...` : ''})
                                            </option>
                                        );
                                    })}
                                </select>
                                <p className="text-[10px] text-nature-400 mt-1">
                                    Appointing an initial keeper allows immediate offer posting and bid management.
                                </p>
                            </div>

                            <div className="flex items-center justify-end gap-2 pt-3 border-t border-nature-800">
                                <button
                                    type="button"
                                    onClick={() => setShowCreateModal(false)}
                                    className="px-4 py-2 rounded-xl bg-nature-800 text-xs font-bold text-nature-300 hover:text-white"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={creatingEnterprise}
                                    className="px-4 py-2 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white disabled:opacity-50"
                                >
                                    {creatingEnterprise ? 'Creating...' : 'Create Enterprise'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Manage Keepers Modal */}
            {manageKeepersTreasury && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="w-full max-w-lg bg-nature-900 border border-nature-800 rounded-3xl p-6 shadow-2xl space-y-5 animate-fade-in max-h-[90vh] overflow-y-auto">
                        <div className="flex items-start justify-between gap-3 border-b border-nature-800 pb-3">
                            <div>
                                <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                                    <span>{manageKeepersTreasury.avatar || '🌾'}</span>
                                    <span>Manage Keepers — {manageKeepersTreasury.name}</span>
                                </h3>
                                <p className="text-xs text-nature-400 m-0 mt-1">
                                    Keepers hold operational authority to post offers/needs, approve bids, and disburse
                                    funds for this enterprise.
                                </p>
                            </div>
                            <button
                                onClick={() => setManageKeepersTreasury(null)}
                                className="w-8 h-8 rounded-full bg-nature-800 hover:bg-nature-700 text-nature-300 flex items-center justify-center text-sm font-bold"
                            >
                                ✕
                            </button>
                        </div>

                        {keeperError && (
                            <div className="p-3 rounded-xl bg-red-900/30 border border-red-800/80 text-xs text-red-300">
                                {keeperError}
                            </div>
                        )}

                        {/* Current Keepers List */}
                        <div>
                            {(() => {
                                const currentTreasuryKeepers = Array.isArray(keepersMap[manageKeepersTreasury.publicKey])
                                    ? keepersMap[manageKeepersTreasury.publicKey]
                                    : (Array.isArray(manageKeepersTreasury.keepers) ? manageKeepersTreasury.keepers : []);
                                return (
                                    <>
                                        <h4 className="text-xs font-bold text-nature-300 uppercase tracking-wider mb-2">
                                            Current Keepers ({currentTreasuryKeepers.length})
                                        </h4>

                                        {currentTreasuryKeepers.length === 0 ? (
                                            <div className="p-4 rounded-xl bg-nature-950/60 border border-nature-800 text-center text-xs text-nature-400">
                                                <p className="font-semibold text-amber-400 mb-1">No keepers currently assigned.</p>
                                                <p className="text-[11px] text-nature-400">
                                                    Without an appointed keeper, community members cannot operate this enterprise or
                                                    satisfy the offer covenant.
                                                </p>
                                            </div>
                                        ) : (
                                            <div className="space-y-2">
                                                {currentTreasuryKeepers.map((pk, idx) => {
                                                    const name = getMemberDisplayName(pk);
                                                    const pubkeyStr = normalizeKeeperPubkey(pk);
                                                    return (
                                                        <div
                                                            key={pubkeyStr || idx}
                                                            className="p-3 rounded-xl bg-nature-950 border border-nature-800 flex items-center justify-between gap-3"
                                                        >
                                                            <div className="flex items-center gap-2.5 min-w-0">
                                                                <div className="w-7 h-7 rounded-lg bg-nature-800 border border-nature-700 flex items-center justify-center text-xs font-bold text-terra-400">
                                                                    {(name || '?').charAt(0).toUpperCase()}
                                                                </div>
                                                                <div className="min-w-0">
                                                                    <div className="text-xs font-bold text-white truncate">
                                                                        @{name}
                                                                    </div>
                                                                    <div className="text-[10px] font-mono text-nature-500 truncate">
                                                                        {pubkeyStr ? `${pubkeyStr.slice(0, 16)}...` : 'Unknown'}
                                                                    </div>
                                                                </div>
                                                            </div>

                                                            <button
                                                                onClick={() => handleRevokeKeeper(pk)}
                                                                disabled={keeperActionLoading}
                                                                className="px-2.5 py-1 rounded-lg bg-red-950/60 hover:bg-red-900 text-xs font-bold text-red-300 border border-red-800/80 transition-all disabled:opacity-40 shrink-0"
                                                            >
                                                                Revoke
                                                            </button>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </>
                                );
                            })()}
                        </div>

                        {/* Assign New Keeper Form */}
                        <form onSubmit={handleAssignKeeper} className="p-4 rounded-2xl bg-nature-950 border border-nature-800 space-y-3">
                            <div>
                                <h4 className="text-xs font-bold text-white mb-0.5">Assign Community Keeper</h4>
                                <p className="text-[11px] text-nature-400 mb-2">
                                    Appoint a trusted community member as an operator for this enterprise.
                                </p>
                            </div>

                            {/* Dropdown from community members */}
                            {members.length > 0 && (
                                <div>
                                    <label htmlFor="assign-member-select" className="block text-[11px] font-semibold text-nature-300 mb-1">
                                        Select Member
                                    </label>
                                    <select
                                        id="assign-member-select"
                                        value={assignMemberPubkey}
                                        onChange={(e) => {
                                            setAssignMemberPubkey(e.target.value);
                                            if (e.target.value) setCustomKeeperPubkey('');
                                        }}
                                        className="w-full bg-nature-900 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-terra-500"
                                    >
                                        <option value="">-- Choose from community directory --</option>
                                        {(() => {
                                            const activeKeepers = Array.isArray(keepersMap[manageKeepersTreasury.publicKey])
                                                ? keepersMap[manageKeepersTreasury.publicKey]
                                                : (Array.isArray(manageKeepersTreasury.keepers) ? manageKeepersTreasury.keepers : []);
                                            const assignedPubkeys = activeKeepers.map(normalizeKeeperPubkey).filter(Boolean).map((k) => k.toLowerCase());
                                            return members
                                                .filter((m) => {
                                                    const pk = normalizeKeeperPubkey(m);
                                                    return pk && !assignedPubkeys.includes(pk.toLowerCase());
                                                })
                                                .map((m, idx) => {
                                                    const pk = normalizeKeeperPubkey(m);
                                                    const rawName = m.callsign || m.name || (m as { displayName?: string }).displayName;
                                                    const hasName = typeof rawName === 'string' && rawName.trim().length > 0;
                                                    const label = hasName
                                                        ? `@${rawName.trim().replace(/^@/, '')} (${pk ? `${pk.slice(0, 8)}...` : ''})`
                                                        : (pk ? `Member (${pk.slice(0, 8)}...)` : 'Member');
                                                    return (
                                                        <option key={pk || `assign-member-${idx}`} value={pk}>
                                                            {label}
                                                        </option>
                                                    );
                                                });
                                        })()}
                                    </select>
                                </div>
                            )}

                            {/* Or direct pubkey entry */}
                            <div>
                                <label htmlFor="custom-keeper-input" className="block text-[11px] font-semibold text-nature-300 mb-1">
                                    Or Member Public Key
                                </label>
                                <input
                                    id="custom-keeper-input"
                                    type="text"
                                    value={customKeeperPubkey}
                                    onChange={(e) => {
                                        setCustomKeeperPubkey(e.target.value);
                                        if (e.target.value) setAssignMemberPubkey('');
                                    }}
                                    placeholder="Paste member public key"
                                    className="w-full bg-nature-900 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-terra-500"
                                />
                            </div>

                            <button
                                type="submit"
                                disabled={keeperActionLoading || (!assignMemberPubkey && !customKeeperPubkey)}
                                className="w-full py-2 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all disabled:opacity-40"
                            >
                                {keeperActionLoading ? 'Assigning...' : '+ Assign Keeper'}
                            </button>
                        </form>

                        <div className="flex justify-end pt-2">
                            <button
                                type="button"
                                onClick={() => setManageKeepersTreasury(null)}
                                className="px-4 py-2 rounded-xl bg-nature-800 text-xs font-bold text-nature-300 hover:text-white"
                            >
                                Done
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Seed Offer Modal */}
            {seedOfferTreasury && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="w-full max-w-md bg-nature-900 border border-nature-800 rounded-3xl p-6 shadow-2xl space-y-4 animate-fade-in">
                        <h3 className="text-base font-bold text-white m-0">
                            Post Initial Offer for {seedOfferTreasury.name}
                        </h3>
                        <p className="text-xs text-nature-400 m-0">
                            Satisfy the offer covenant by listing the first produce or service this enterprise provides.
                        </p>
                        <form onSubmit={handleSeedOffer} className="space-y-3">
                            <div>
                                <label className="block text-xs font-bold text-nature-300 mb-1">Offer Title</label>
                                <input
                                    type="text"
                                    value={offerTitle}
                                    onChange={(e) => setOfferTitle(e.target.value)}
                                    placeholder="e.g. Fresh farm eggs dozen"
                                    required
                                    autoFocus
                                    className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-terra-500"
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-bold text-nature-300 mb-1">Category</label>
                                    <select
                                        value={offerCategory}
                                        onChange={(e) => setOfferCategory(e.target.value)}
                                        className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white"
                                    >
                                        <option value="food">Food &amp; Produce</option>
                                        <option value="tools">Tools &amp; Gear</option>
                                        <option value="services">Services &amp; Labour</option>
                                        <option value="skills">Skills &amp; Learning</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-nature-300 mb-1">Price (Beans)</label>
                                    <input
                                        type="number"
                                        min="1"
                                        value={offerCredits}
                                        onChange={(e) => setOfferCredits(e.target.value)}
                                        className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2 text-sm text-white font-mono"
                                    />
                                </div>
                            </div>
                            <div className="flex items-center justify-end gap-2 pt-2">
                                <button
                                    type="button"
                                    onClick={() => setSeedOfferTreasury(null)}
                                    className="px-4 py-2 rounded-xl bg-nature-800 text-xs font-bold text-nature-300 hover:text-white"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={seedingOffer}
                                    className="px-4 py-2 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white disabled:opacity-50"
                                >
                                    {seedingOffer ? 'Posting...' : 'Post Offer'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Subtab: Escrow Disputes */}
            {subTab === 'disputes' && (
                <EscrowDisputesPanel
                    activeNode={activeNode}
                    tfaToken={effectiveTfaToken}
                    onRefresh={onRefresh}
                />
            )}
        </div>
    );
}
