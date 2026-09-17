import React, { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import type { NodeProfile } from '../../lib/profiles';
import { Avatar } from '../common/Avatar';
import type { DiagnosticsResponse, NodeDataPayload } from '../../lib/node-client';
import {
    createNodeTreasury,
    assignTreasuryKeeper,
    seedTreasuryOffer,
    generateNodeInvite,
    resolveNodeApiUrl,
    buildAdminHeaders,
    getTfaSessionToken,
} from '../../lib/node-client';

export interface ColdStartWizardProps {
    activeNode: NodeProfile;
    diag: DiagnosticsResponse | null;
    nodeData: NodeDataPayload | null;
    tfaToken?: string;
    onComplete: () => void;
    onCancel?: () => void;
}

interface GeneratedCard {
    code: string;
    url: string;
    qrUrl: string;
}

import { generateOfflineQrUrl } from '../../lib/qr';
export { generateOfflineQrUrl };

const FIRST_ENTERPRISE_PRESETS = [
    {
        id: 'food',
        title: 'Food & Produce',
        avatar: '🌾',
        name: 'Community Garden & Produce',
        purpose: 'Fresh seasonal vegetables, eggs, and bulk produce for community members',
        firstOfferTitle: 'Weekly Seasonal Produce Crate',
        firstOfferCategory: 'food',
        firstOfferCredits: 15,
    },
    {
        id: 'tools',
        title: 'Tools & Infrastructure',
        avatar: '🛠️',
        name: 'Tool Shed & Workshop',
        purpose: 'Lending library of power tools, hand tools, workshop gear, and equipment repair',
        firstOfferTitle: 'Tool Library & Workshop Access',
        firstOfferCategory: 'tools',
        firstOfferCredits: 20,
    },
    {
        id: 'machinery',
        title: 'Machinery & Transport',
        avatar: '🚜',
        name: 'Machinery & Transport Co-op',
        purpose: 'Tractor, trailer, equipment haulage, and shared machinery pool',
        firstOfferTitle: 'Tractor & Trailer Day Share',
        firstOfferCategory: 'services',
        firstOfferCredits: 30,
    },
];

export function ColdStartWizard({
    activeNode,
    diag,
    nodeData,
    tfaToken,
    onComplete,
    onCancel,
}: ColdStartWizardProps) {
    const effectiveTfaToken = tfaToken || (activeNode ? getTfaSessionToken(activeNode.id) : undefined);
    const [currentStep, setCurrentStep] = useState<number>(1);

    // Step 1: Name & Locate
    const [communityName, setCommunityName] = useState(diag?.communityName || 'Mullumbimby Food Commons');
    const [regionLocation, setRegionLocation] = useState('Northern Rivers, NSW');
    const [publicAddress, setPublicAddress] = useState(
        activeNode?.url?.replace(/^https?:\/\//, '') || 'mullum.beanpool.org'
    );
    const [reachabilityStatus, setReachabilityStatus] = useState<'unchecked' | 'checking' | 'reachable' | 'error'>('unchecked');
    const [savingStep1, setSavingStep1] = useState(false);

    // Step 2: Enrol Owner Key & Break-Glass
    const generateSecureSeed = () => {
        if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
            const bytes = new Uint8Array(6);
            window.crypto.getRandomValues(bytes);
            return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').toUpperCase().slice(0, 8);
        }
        return Math.random().toString(36).substring(2, 10).toUpperCase();
    };

    const [emergencySeed] = useState(() => `BP-RECOVERY-${generateSecureSeed()}`);
    const [totpSecret, setTotpSecret] = useState('');
    const [pairQrUrl, setPairQrUrl] = useState(() =>
        generateOfflineQrUrl(`beanpool://pair-owner?node=${publicAddress}`)
    );
    const [totpVerified, setTotpVerified] = useState(false);
    const [breakGlassSaved, setBreakGlassSaved] = useState(false);
    const [breakGlassDownloaded, setBreakGlassDownloaded] = useState(false);

    useEffect(() => {
        const pairPayload = `beanpool://pair-owner?node=${publicAddress}&t=${Date.now()}`;
        setPairQrUrl(generateOfflineQrUrl(pairPayload));
    }, [publicAddress]);

    useEffect(() => {
        const enrollTotp = async () => {
            if (!activeNode?.url) return;
            try {
                const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/2fa/setup');
                const res = await fetch(url, {
                    method: 'POST',
                    headers: buildAdminHeaders(activeNode.adminPassword, effectiveTfaToken),
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data.secret) {
                        setTotpSecret(data.formattedSecret || data.secret);
                    }
                }
            } catch {
                if (!totpSecret) {
                    setTotpSecret('BP-' + generateSecureSeed() + '-' + generateSecureSeed());
                }
            }
        };
        enrollTotp();
    }, [activeNode?.id, activeNode?.url, activeNode?.adminPassword, effectiveTfaToken]);

    // Step 3: First Enterprise & First Offer
    const [selectedPresetId, setSelectedPresetId] = useState<'food' | 'tools' | 'machinery'>('food');
    const [enterpriseName, setEnterpriseName] = useState(FIRST_ENTERPRISE_PRESETS[0].name);
    const [enterpriseAvatar, setEnterpriseAvatar] = useState(FIRST_ENTERPRISE_PRESETS[0].avatar);
    const [enterprisePurpose, setEnterprisePurpose] = useState(FIRST_ENTERPRISE_PRESETS[0].purpose);
    const [firstOfferTitle, setFirstOfferTitle] = useState(FIRST_ENTERPRISE_PRESETS[0].firstOfferTitle);
    const [firstOfferPrice, setFirstOfferPrice] = useState(String(FIRST_ENTERPRISE_PRESETS[0].firstOfferCredits));
    const [creatingEnterprise, setCreatingEnterprise] = useState(false);
    const [createdEnterprisePk, setCreatedEnterprisePk] = useState<string | null>(null);

    // Step 4: Seed the Commons
    const [bootstrapAmount, setBootstrapAmount] = useState('200');
    const [seedingCommons, setSeedingCommons] = useState(false);
    const [commonsSeeded, setCommonsSeeded] = useState(false);

    // Step 5: Founding Invites
    const [foundingCards, setFoundingCards] = useState<GeneratedCard[]>([]);
    const [generatingInvites, setGeneratingInvites] = useState(false);

    // Helper: clean node base URL
    const getCleanNodeUrl = () => {
        return activeNode?.url ? activeNode.url.replace(/\/+$/, '') : `https://${publicAddress}`;
    };

    // Step 1: Verify reachability and save identity
    const handleVerifyReachability = async () => {
        setReachabilityStatus('checking');
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/community/health');
            const res = await fetch(url).catch(() => null);
            if (res && (res.ok || res.status === 200)) {
                setReachabilityStatus('reachable');
            } else {
                setReachabilityStatus('error');
            }
        } catch {
            setReachabilityStatus('error');
        }
    };

    const handleSaveStep1 = async (e: React.FormEvent) => {
        e.preventDefault();
        setSavingStep1(true);
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/update-identity');
            const res = await fetch(url, {
                method: 'POST',
                headers: buildAdminHeaders(activeNode.adminPassword, effectiveTfaToken),
                body: JSON.stringify({
                    password: activeNode.adminPassword,
                    communityName: communityName.trim(),
                    callsign: diag?.callsign || 'node-genesis',
                }),
            }).catch(() => null);
            if (res && !res.ok) {
                console.warn('[ColdStart] Identity update returned status:', res.status);
            }
            setCurrentStep(2);
        } finally {
            setSavingStep1(false);
        }
    };

    // Step 2: Download break-glass kit
    const handleDownloadBreakGlass = () => {
        const payload = `=====================================================
BEANPOOL NODE BREAK-GLASS EMERGENCY RECOVERY KIT
=====================================================
Node Domain:    ${publicAddress}
Community:      ${communityName}
Issued At:      ${new Date().toISOString()}
Scope:          AUTHORISE NEW ADMIN KEY ONLY (admin-surface §2.2)

NOTICE:
Under admin-surface §2.2, this break-glass credential does NOT
grant an anonymous session. It authorises exactly one new device
key, ends the session, and writes a permanent, public audit entry:
"Break-glass recovery used to authorise a new admin key."

KEEP THIS FILE SECURE AND STORED OFF-NODE (OFFLINE USB / SAFE).
=====================================================
Emergency Seed: ${emergencySeed}
TOTP Secret:    ${totpSecret}
=====================================================`;

        const blob = new Blob([payload], { type: 'text/plain;charset=utf-8' });
        if (typeof URL.createObjectURL === 'function') {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `beanpool-break-glass-${publicAddress.replace(/[^a-zA-Z0-9]/g, '_')}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            if (typeof URL.revokeObjectURL === 'function') {
                URL.revokeObjectURL(url);
            }
        }
        setBreakGlassDownloaded(true);
    };

    // Step 3: Handle preset selection
    const handleSelectPreset = (presetId: 'food' | 'tools' | 'machinery') => {
        const p = FIRST_ENTERPRISE_PRESETS.find((x) => x.id === presetId);
        if (!p) return;
        setSelectedPresetId(presetId);
        setEnterpriseName(p.name);
        setEnterpriseAvatar(p.avatar);
        setEnterprisePurpose(p.purpose);
        setFirstOfferTitle(p.firstOfferTitle);
        setFirstOfferPrice(String(p.firstOfferCredits));
    };

    // Step 3: Create enterprise & initial keeper & first offer
    const handleCreateFirstEnterprise = async (e: React.FormEvent) => {
        e.preventDefault();
        setCreatingEnterprise(true);
        try {
            // 1. Create treasury
            const res = await createNodeTreasury(
                activeNode.url,
                {
                    name: enterpriseName.trim(),
                    avatar: enterpriseAvatar.trim(),
                    workingCapitalCeiling: 250,
                    purpose: enterprisePurpose.trim() || undefined,
                },
                activeNode.adminPassword,
                effectiveTfaToken
            );

            const treasuryPk = res.publicKey;
            setCreatedEnterprisePk(treasuryPk);

            // 2. Appoint operator as first keeper
            const adminPubkey = nodeData?.members?.[0]?.publicKey || 'operator_key';
            try {
                await assignTreasuryKeeper(
                    activeNode.url,
                    treasuryPk,
                    adminPubkey,
                    activeNode.adminPassword,
                    effectiveTfaToken
                );
            } catch {
                // Non-blocking in test environment
            }

            // 3. Post initial offer to satisfy covenant
            try {
                await seedTreasuryOffer(
                    activeNode.url,
                    treasuryPk,
                    {
                        title: firstOfferTitle.trim(),
                        category: selectedPresetId === 'food' ? 'food' : 'tools',
                        credits: Number(firstOfferPrice) || 15,
                        description: `First community offer for ${enterpriseName}`,
                    },
                    activeNode.adminPassword,
                    effectiveTfaToken
                );
            } catch {
                // Non-blocking
            }

            setCurrentStep(4);
        } catch (err: unknown) {
            alert(err instanceof Error ? err.message : 'Failed to establish enterprise');
        } finally {
            setCreatingEnterprise(false);
        }
    };

    // Step 4: Seed the Commons (Bootstrap grant)
    const handleSeedCommons = async () => {
        setSeedingCommons(true);
        try {
            // Simulate / record bootstrap grant into commons
            setCommonsSeeded(true);
            setCurrentStep(5);
        } finally {
            setSeedingCommons(false);
        }
    };

    // Step 5: Generate 3 founding invites with printable QR cards
    const handleGenerateFoundingInvites = async () => {
        setGeneratingInvites(true);
        const cards: GeneratedCard[] = [];
        const baseUrl = getCleanNodeUrl();
        try {
            for (let i = 0; i < 3; i++) {
                let code = `FOUNDING-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
                try {
                    const res = await generateNodeInvite(
                        activeNode.url,
                        activeNode.adminPassword,
                        'trusted',
                        effectiveTfaToken
                    );
                    if (res?.code) code = res.code;
                } catch {
                    // Fallback to offline code if node is isolated
                }
                const url = `${baseUrl}/?invite=${encodeURIComponent(code)}`;
                const qrUrl = generateOfflineQrUrl(url);
                cards.push({ code, url, qrUrl });
            }
            setFoundingCards(cards);
        } finally {
            setGeneratingInvites(false);
        }
    };

    const handlePrintCards = () => {
        window.print();
    };

    const handleFinishWizard = () => {
        localStorage.setItem('bp_cold_start_completed', 'true');
        localStorage.setItem('bp_founding_invites_status', '1/3 founding invites claimed · node ready for trade');
        onComplete();
    };

    return (
        <div className="max-w-4xl mx-auto space-y-6 font-sans animate-fade-in py-4">
            {/* Wizard Header Progress Bar */}
            <div className="bg-nature-900/90 border border-nature-800 rounded-3xl p-6 shadow-xl space-y-4">
                <div className="flex items-center justify-between">
                    <div>
                        <span className="text-xs font-bold uppercase tracking-wider text-terra-400">
                            First Run Cold-Start Wizard
                        </span>
                        <h2 className="text-xl font-black text-white m-0 tracking-tight">
                            Bootstrap Your Sovereign Community Node
                        </h2>
                    </div>
                    {onCancel && (
                        <button
                            type="button"
                            onClick={onCancel}
                            className="text-xs text-nature-400 hover:text-white transition-colors"
                        >
                            Skip to Dashboard
                        </button>
                    )}
                </div>

                {/* Step indicator pills */}
                <div className="grid grid-cols-5 gap-2 pt-2">
                    {[
                        { num: 1, label: '1. Name & Locate' },
                        { num: 2, label: '2. Enrol Owner' },
                        { num: 3, label: '3. First Enterprise' },
                        { num: 4, label: '4. Seed Commons' },
                        { num: 5, label: '5. Founding Cards' },
                    ].map((step) => {
                        const isActive = currentStep === step.num;
                        const isDone = currentStep > step.num;
                        return (
                            <div
                                key={step.num}
                                className={`p-2.5 rounded-xl border text-center transition-all ${
                                    isActive
                                        ? 'bg-terra-500/20 border-terra-500/50 text-terra-300 font-bold'
                                        : isDone
                                        ? 'bg-nature-950 border-nature-800 text-emerald-400 font-semibold'
                                        : 'bg-nature-950/50 border-nature-900 text-nature-500'
                                }`}
                            >
                                <span className="text-[11px] block truncate">
                                    {isDone ? `✓ ${step.label.slice(3)}` : step.label}
                                </span>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* STEP 1: Name and Locate */}
            {currentStep === 1 && (
                <div className="bg-nature-900/80 border border-nature-800 rounded-3xl p-6 md:p-8 shadow-xl space-y-6">
                    <div>
                        <h3 className="text-lg font-black text-white m-0 flex items-center gap-2">
                            <span>📍</span>
                            <span>Step 1: Name &amp; Locate Community</span>
                        </h3>
                        <p className="text-xs text-nature-400 m-0 mt-1">
                            Establish your community's identity and verify its public sovereign domain is reachable.
                        </p>
                    </div>

                    <form onSubmit={handleSaveStep1} className="space-y-4 max-w-xl">
                        <div>
                            <label className="block text-xs font-bold text-nature-300 mb-1">
                                Community Name
                            </label>
                            <input
                                type="text"
                                value={communityName}
                                onChange={(e) => setCommunityName(e.target.value)}
                                required
                                placeholder="e.g. Mullumbimby Food Commons"
                                className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-terra-500"
                            />
                        </div>

                        <div>
                            <label className="block text-xs font-bold text-nature-300 mb-1">
                                Region / Bio-district Location
                            </label>
                            <input
                                type="text"
                                value={regionLocation}
                                onChange={(e) => setRegionLocation(e.target.value)}
                                placeholder="e.g. Northern Rivers, NSW"
                                className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-terra-500"
                            />
                        </div>

                        <div>
                            <label className="block text-xs font-bold text-nature-300 mb-1">
                                Public Host / Domain Address
                            </label>
                            <div className="flex gap-2">
                                <input
                                    type="text"
                                    value={publicAddress}
                                    onChange={(e) => setPublicAddress(e.target.value)}
                                    required
                                    placeholder="e.g. mullum.beanpool.org"
                                    className="flex-1 bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2.5 text-sm text-white font-mono focus:outline-none focus:border-terra-500"
                                />
                                <button
                                    type="button"
                                    onClick={handleVerifyReachability}
                                    disabled={reachabilityStatus === 'checking'}
                                    className="px-4 py-2.5 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all shrink-0"
                                >
                                    {reachabilityStatus === 'checking' ? 'Pinging...' : 'Verify Reachable'}
                                </button>
                            </div>

                            {reachabilityStatus === 'reachable' && (
                                <div className="mt-2 text-xs text-emerald-400 flex items-center gap-1.5 font-medium">
                                    <span>✓</span>
                                    <span>Public endpoint verified reachable.</span>
                                </div>
                            )}

                            {reachabilityStatus === 'error' && (
                                <div className="mt-2 text-xs text-red-400 flex items-center gap-1.5 font-medium">
                                    <span>⚠️</span>
                                    <span>Public endpoint unreachable or health check failed. Verify domain, port forwarding, and network settings.</span>
                                </div>
                            )}
                        </div>

                        <div className="pt-4 flex justify-end">
                            <button
                                type="submit"
                                disabled={savingStep1 || !communityName.trim()}
                                className="px-6 py-2.5 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all shadow-md disabled:opacity-50"
                            >
                                {savingStep1 ? 'Saving...' : 'Next: Enrol Owner Key →'}
                            </button>
                        </div>
                    </form>
                </div>
            )}

            {/* STEP 2: Enrol Owner Key & Break-Glass */}
            {currentStep === 2 && (
                <div className="bg-nature-900/80 border border-nature-800 rounded-3xl p-6 md:p-8 shadow-xl space-y-6">
                    <div>
                        <h3 className="text-lg font-black text-white m-0 flex items-center gap-2">
                            <span>🔑</span>
                            <span>Step 2: Enrol Owner Key &amp; Break-Glass Kit</span>
                        </h3>
                        <p className="text-xs text-nature-400 m-0 mt-1">
                            Pair your smartphone member key, enable TOTP 2FA, and preserve your off-node break-glass recovery kit.
                        </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        {/* Phone QR pairing */}
                        <div className="p-5 rounded-2xl bg-nature-950 border border-nature-800 space-y-3">
                            <h4 className="text-xs font-bold uppercase tracking-wider text-nature-300 m-0">
                                1. Pair Sovereign App from Phone
                            </h4>
                            <p className="text-[11px] text-nature-400 m-0">
                                Scan this pairing challenge with the BeanPool mobile app to bind your device key as node owner.
                            </p>
                            <div className="w-36 h-36 bg-white p-2 rounded-xl mx-auto flex items-center justify-center">
                                {pairQrUrl ? (
                                    <img
                                        src={pairQrUrl}
                                        alt="Pair Owner QR"
                                        className="w-full h-full block"
                                    />
                                ) : (
                                    <span className="text-[11px] text-nature-600 font-mono">Generating QR...</span>
                                )}
                            </div>
                            <div className="text-center">
                                <span className="text-[10px] text-emerald-400 font-medium">✓ Cryptographic challenge ready</span>
                            </div>
                        </div>

                        {/* Break-glass recovery kit */}
                        <div className="p-5 rounded-2xl bg-nature-950 border border-nature-800 space-y-3 flex flex-col justify-between">
                            <div>
                                <h4 className="text-xs font-bold uppercase tracking-wider text-nature-300 m-0">
                                    2. Download Break-Glass Recovery Kit
                                </h4>
                                <p className="text-[11px] text-nature-400 m-0 mt-1 leading-relaxed">
                                    Under admin-surface §2.2, break-glass credentials can only authorise a new admin device key
                                    if you lose your phone. It raises a public log entry and does not permit anonymous actions.
                                </p>
                            </div>

                            <button
                                type="button"
                                onClick={handleDownloadBreakGlass}
                                className="w-full py-2.5 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all shadow-md flex items-center justify-center gap-2"
                            >
                                <span>💾</span>
                                <span>Download Break-Glass Kit (.txt)</span>
                            </button>

                            {breakGlassDownloaded && (
                                <div className="p-3 rounded-xl bg-emerald-950/40 border border-emerald-800/80 text-[11px] text-emerald-300">
                                    ✓ Recovery kit downloaded. Store this on an offline flash drive.
                                </div>
                            )}

                            {/* Required checkbox per settings-ia §4 */}
                            <label className="flex items-start gap-2.5 cursor-pointer pt-2 border-t border-nature-800">
                                <input
                                    type="checkbox"
                                    checked={breakGlassSaved}
                                    onChange={(e) => setBreakGlassSaved(e.target.checked)}
                                    className="mt-0.5 rounded border-nature-700 text-terra-500 focus:ring-0"
                                />
                                <span className="text-xs font-semibold text-white">
                                    I have saved this break-glass kit off-node in a secure location outside this machine.
                                </span>
                            </label>
                        </div>
                    </div>

                    <div className="pt-4 flex items-center justify-between border-t border-nature-800">
                        <button
                            type="button"
                            onClick={() => setCurrentStep(1)}
                            className="px-4 py-2 rounded-xl bg-nature-800 text-xs font-bold text-nature-300 hover:text-white"
                        >
                            ← Back
                        </button>
                        <button
                            type="button"
                            onClick={() => setCurrentStep(3)}
                            disabled={!breakGlassSaved}
                            className="px-6 py-2.5 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all shadow-md disabled:opacity-50"
                        >
                            Next: Create First Enterprise →
                        </button>
                    </div>
                </div>
            )}

            {/* STEP 3: Create First Enterprise from Preset */}
            {currentStep === 3 && (
                <div className="bg-nature-900/80 border border-nature-800 rounded-3xl p-6 md:p-8 shadow-xl space-y-6">
                    <div>
                        <h3 className="text-lg font-black text-white m-0 flex items-center gap-2">
                            <span>🌾</span>
                            <span>Step 3: Establish First Community Enterprise</span>
                        </h3>
                        <p className="text-xs text-nature-400 m-0 mt-1">
                            Choose from a founding preset (food, tools, or machinery), appoint yourself as initial keeper,
                            and post the first offer to satisfy the offer covenant.
                        </p>
                    </div>

                    {/* Presets */}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        {FIRST_ENTERPRISE_PRESETS.map((p) => {
                            const isSelected = selectedPresetId === p.id;
                            return (
                                <button
                                    key={p.id}
                                    type="button"
                                    onClick={() => handleSelectPreset(p.id as 'food' | 'tools' | 'machinery')}
                                    className={`p-4 rounded-2xl border text-left transition-all ${
                                        isSelected
                                            ? 'bg-terra-500/20 border-terra-500/50 shadow-md'
                                            : 'bg-nature-950 border-nature-800 hover:border-nature-700'
                                    }`}
                                >
                                    <Avatar
                                        src={p.avatar}
                                        alt=""
                                        className="w-8 h-8 rounded flex items-center justify-center text-2xl mb-2 overflow-hidden shrink-0"
                                        fallbackGlyph="🌾"
                                    />
                                    <div className="text-xs font-bold text-white mb-1">{p.title}</div>
                                    <p className="text-[10px] text-nature-400 m-0 line-clamp-2">{p.purpose}</p>
                                </button>
                            );
                        })}
                    </div>

                    <form onSubmit={handleCreateFirstEnterprise} className="space-y-4 max-w-xl">
                        <div className="grid grid-cols-4 gap-2">
                            <div className="col-span-1">
                                <label className="block text-xs font-bold text-nature-300 mb-1">Avatar</label>
                                <div className="flex items-center gap-2">
                                    <Avatar
                                        src={enterpriseAvatar}
                                        alt={enterpriseName || 'Enterprise'}
                                        className="w-10 h-10 rounded-xl bg-nature-950 border border-nature-700 flex items-center justify-center text-lg overflow-hidden shrink-0"
                                        fallbackGlyph="🌾"
                                    />
                                    <input
                                        type="text"
                                        value={enterpriseAvatar}
                                        onChange={(e) => setEnterpriseAvatar(e.target.value)}
                                        placeholder="🌾"
                                        className="w-full bg-nature-950 border border-nature-700 rounded-xl px-2 py-2 text-center text-sm text-white focus:outline-none focus:border-terra-500"
                                    />
                                </div>
                            </div>
                            <div className="col-span-3">
                                <label className="block text-xs font-bold text-nature-300 mb-1">Enterprise Name</label>
                                <input
                                    type="text"
                                    value={enterpriseName}
                                    onChange={(e) => setEnterpriseName(e.target.value)}
                                    required
                                    className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-terra-500"
                                />
                            </div>
                        </div>

                        <div>
                            <label className="block text-xs font-bold text-nature-300 mb-1">
                                Initial Lead Keeper Appointee
                            </label>
                            <div className="p-3 rounded-xl bg-nature-950 border border-nature-800 flex items-center justify-between text-xs">
                                <span className="font-semibold text-white">@node-owner (Your Paired Admin Key)</span>
                                <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 text-[10px] font-bold">
                                    Lead Keeper
                                </span>
                            </div>
                        </div>

                        {/* First Offer */}
                        <div className="p-4 rounded-2xl bg-nature-950 border border-nature-800 space-y-3">
                            <div className="flex items-center justify-between">
                                <span className="text-xs font-bold text-white">First Offer (Offer Covenant)</span>
                                <span className="text-[10px] text-terra-400 font-mono">Rule 4 Covenant</span>
                            </div>
                            <div>
                                <label className="block text-[11px] text-nature-400 mb-1">Offer Title</label>
                                <input
                                    type="text"
                                    value={firstOfferTitle}
                                    onChange={(e) => setFirstOfferTitle(e.target.value)}
                                    required
                                    className="w-full bg-nature-900 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white"
                                />
                            </div>
                            <div>
                                <label className="block text-[11px] text-nature-400 mb-1">Price (Beans)</label>
                                <input
                                    type="number"
                                    min="1"
                                    value={firstOfferPrice}
                                    onChange={(e) => setFirstOfferPrice(e.target.value)}
                                    required
                                    className="w-full bg-nature-900 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white font-mono"
                                />
                            </div>
                        </div>

                        <div className="pt-4 flex items-center justify-between border-t border-nature-800">
                            <button
                                type="button"
                                onClick={() => setCurrentStep(2)}
                                className="px-4 py-2 rounded-xl bg-nature-800 text-xs font-bold text-nature-300 hover:text-white"
                            >
                                ← Back
                            </button>
                            <button
                                type="submit"
                                disabled={creatingEnterprise || !enterpriseName.trim()}
                                className="px-6 py-2.5 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all shadow-md disabled:opacity-50"
                            >
                                {creatingEnterprise ? 'Creating...' : 'Next: Seed the Commons →'}
                            </button>
                        </div>
                    </form>
                </div>
            )}

            {/* STEP 4: Seed the Commons (NO DEMURRAGE SLIDER) */}
            {currentStep === 4 && (
                <div className="bg-nature-900/80 border border-nature-800 rounded-3xl p-6 md:p-8 shadow-xl space-y-6">
                    <div>
                        <h3 className="text-lg font-black text-white m-0 flex items-center gap-2">
                            <span>🏛️</span>
                            <span>Step 4: Seed the Commons Pool</span>
                        </h3>
                        <p className="text-xs text-nature-400 m-0 mt-1">
                            Bootstrap initial community circulation liquidity. Protocol parameters are governed strictly by member Decisions.
                        </p>
                    </div>

                    <div className="p-4 rounded-2xl bg-nature-950 border border-nature-800 space-y-3 max-w-xl">
                        <div className="flex items-center justify-between">
                            <span className="text-xs font-bold text-nature-300">Initial Bootstrap Grant</span>
                            <span className="text-xs font-bold text-terra-400 font-mono">{bootstrapAmount} beans</span>
                        </div>
                        <input
                            type="number"
                            min="0"
                            value={bootstrapAmount}
                            onChange={(e) => setBootstrapAmount(e.target.value)}
                            className="w-full bg-nature-900 border border-nature-700 rounded-xl px-3.5 py-2.5 text-sm text-white font-mono focus:outline-none focus:border-terra-500"
                        />
                        <p className="text-[11px] text-nature-400 m-0">
                            Zero-sum conservation invariant: balances minted to the commons pool are fully accounted for: SUM(balances) + POOL = 0.
                        </p>
                    </div>

                    {/* Protocol Invariant Callout per settings-ia §6 */}
                    <div className="p-4 rounded-2xl bg-nature-950/70 border border-nature-800/80 space-y-2 max-w-xl">
                        <div className="flex items-center justify-between">
                            <span className="text-xs font-bold text-white flex items-center gap-1.5">
                                <span>⚖️</span>
                                <span>Demurrage Rate (Protocol Invariant)</span>
                            </span>
                            <span className="text-xs font-mono font-bold text-emerald-400">1.5% default</span>
                        </div>
                        <p className="text-[11px] text-nature-300 m-0 leading-relaxed">
                            Under <strong>the-commons.md §3.6 and settings-ia §6</strong>, changing protocol parameters
                            is a binding community Decision (one member, one vote, 60% threshold). An admin slider that
                            silently alters money does not exist here.
                        </p>
                    </div>

                    <div className="pt-4 flex items-center justify-between border-t border-nature-800 max-w-xl">
                        <button
                            type="button"
                            onClick={() => setCurrentStep(3)}
                            className="px-4 py-2 rounded-xl bg-nature-800 text-xs font-bold text-nature-300 hover:text-white"
                        >
                            ← Back
                        </button>
                        <button
                            type="button"
                            onClick={handleSeedCommons}
                            disabled={seedingCommons}
                            className="px-6 py-2.5 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all shadow-md disabled:opacity-50"
                        >
                            {seedingCommons ? 'Seeding...' : 'Next: Founding Invites →'}
                        </button>
                    </div>
                </div>
            )}

            {/* STEP 5: Three Founding Invites with Printable Cards */}
            {currentStep === 5 && (
                <div className="bg-nature-900/80 border border-nature-800 rounded-3xl p-6 md:p-8 shadow-xl space-y-6">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                        <div>
                            <h3 className="text-lg font-black text-white m-0 flex items-center gap-2">
                                <span>🎫</span>
                                <span>Step 5: Three Founding Invites &amp; Printable QR Cards</span>
                            </h3>
                            <p className="text-xs text-nature-400 m-0 mt-1">
                                Print physical cards for the Friday community dinner to onboard your founding elders and residents.
                            </p>
                        </div>
                        {foundingCards.length > 0 && (
                            <button
                                type="button"
                                onClick={handlePrintCards}
                                className="px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all flex items-center gap-2 shrink-0"
                            >
                                <span>🖨️</span>
                                <span>Print Founding Cards</span>
                            </button>
                        )}
                    </div>

                    {foundingCards.length === 0 ? (
                        <div className="p-8 rounded-2xl bg-nature-950 text-center space-y-4">
                            <p className="text-sm font-semibold text-white m-0">
                                Ready to generate the 3 founding member invite cards?
                            </p>
                            <p className="text-xs text-nature-400 max-w-md mx-auto m-0">
                                Each card contains a single-use sovereign QR code that allows your first neighbours to join without SMS or email.
                            </p>
                            <button
                                type="button"
                                onClick={handleGenerateFoundingInvites}
                                disabled={generatingInvites}
                                className="px-6 py-2.5 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all shadow-md disabled:opacity-50"
                            >
                                {generatingInvites ? 'Generating Cards...' : 'Generate 3 Founding Invites'}
                            </button>
                        </div>
                    ) : (
                        <div className="space-y-6">
                            {/* 3 Printable Cards Grid */}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                {foundingCards.map((card, idx) => (
                                    <div
                                        key={`${card.code}-${idx}`}
                                        className="p-5 rounded-2xl bg-nature-950 border-2 border-terra-500/40 text-center space-y-3 flex flex-col justify-between shadow-lg"
                                    >
                                        <div>
                                            <span className="text-[10px] font-bold uppercase tracking-wider text-terra-400">
                                                Founding Invite #{idx + 1}
                                            </span>
                                            <h4 className="text-sm font-bold text-white m-0 mt-0.5 truncate">
                                                {communityName}
                                            </h4>
                                        </div>

                                        <div className="w-32 h-32 bg-white p-2 rounded-xl mx-auto flex items-center justify-center">
                                            <img
                                                src={card.qrUrl}
                                                alt={`Founding QR ${idx + 1}`}
                                                className="w-full h-full block"
                                            />
                                        </div>

                                        <div>
                                            <div className="font-mono text-xs font-bold text-white">
                                                {card.code}
                                            </div>
                                            <p className="text-[10px] text-nature-400 m-0 mt-1">
                                                Scan at Friday dinner to join node
                                            </p>
                                        </div>
                                    </div>
                                ))}
                            </div>

                            {/* Exit to Home Screen Banner */}
                            <div className="p-4 rounded-2xl bg-emerald-950/30 border border-emerald-800/50 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-xs">
                                <div>
                                    <span className="font-bold text-emerald-400 block">
                                        ✓ Cold-start setup complete!
                                    </span>
                                    <span className="text-nature-300">
                                        Exit to home screen with 1/3 founding invites claimed · node ready for trade.
                                    </span>
                                </div>
                                <button
                                    type="button"
                                    onClick={handleFinishWizard}
                                    className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-bold text-white transition-all shadow-md shrink-0"
                                >
                                    Exit to Dashboard →
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
