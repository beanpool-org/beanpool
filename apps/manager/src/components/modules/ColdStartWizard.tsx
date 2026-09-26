import React, { useState, useEffect } from 'react';
import { HelpLink } from '../manual/Manual';
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
    setTfaSessionToken,
} from '../../lib/node-client';

export interface ColdStartWizardProps {
    activeNode: NodeProfile;
    diag: DiagnosticsResponse | null;
    nodeData: NodeDataPayload | null;
    tfaToken?: string;
    onComplete: () => void;
    onCancel?: () => void;
    /** Leaves the wizard for Appliance & Data → Access & Security, where 2FA can be finished. */
    onOpenAccessSecurity?: () => void;
    /**
     * Asks the operator for a code from their authenticator (the manager's own 2FA prompt) and resolves with the 2FA
     * session the node issued for it. Rejects when they cancel.
     */
    onRequestTfaCode?: () => Promise<string>;
}

interface GeneratedCard {
    code: string;
    url: string;
    qrUrl: string;
}

import { generateOfflineQrUrl } from '../../lib/qr';
export { generateOfflineQrUrl };

const FOUNDING_INVITE_COUNT = 3;

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

/**
 * What the wizard knows about two-factor sign-in. It says "on" only when the node said so: its status route
 * reported it on, or /2fa/verify accepted a code from the new authenticator.
 */
type TfaState = 'checking' | 'unknown' | 'off' | 'starting' | 'awaiting-code' | 'verifying' | 'on';

type Step1Outcome = { reachable: boolean; reachError: string | null; saved: boolean; saveError: string | null };

type Step3Errors = { create?: string; keeper?: string; offer?: string };

async function errorFrom(res: Response | null): Promise<string> {
    if (!res) return 'no answer';
    const body = await res.json().catch(() => ({} as { error?: string }));
    return (body && typeof body.error === 'string' && body.error) || `HTTP ${res.status}`;
}

export function ColdStartWizard({
    activeNode,
    diag,
    nodeData,
    tfaToken,
    onComplete,
    onCancel,
    onOpenAccessSecurity,
    onRequestTfaCode,
}: ColdStartWizardProps) {
    // A 2FA session issued by turning 2FA on in step 2 outranks whatever the wizard was opened with: once 2FA is on,
    // every later admin call needs it.
    const [freshTfaToken, setFreshTfaToken] = useState<string | undefined>(undefined);
    const effectiveTfaToken = freshTfaToken || tfaToken || (activeNode ? getTfaSessionToken(activeNode.id) : undefined);
    const [currentStep, setCurrentStep] = useState<number>(1);

    const nodeBaseUrl = activeNode?.url ? activeNode.url.replace(/\/+$/, '') : '';
    const nodeHost = nodeBaseUrl.replace(/^https?:\/\//, '') || 'this server';

    // Step 1: Name & check. The step is done only when the node answered its health check AND saved the name.
    const [communityName, setCommunityName] = useState(diag?.communityName || '');
    const [reachabilityStatus, setReachabilityStatus] = useState<'unchecked' | 'checking' | 'reachable' | 'error'>('unchecked');
    const [reachError, setReachError] = useState<string | null>(null);
    const [nameSaved, setNameSaved] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [savingStep1, setSavingStep1] = useState(false);
    const [step1Problem, setStep1Problem] = useState(false);
    // The node refused the save because 2FA is on and this session has no code yet.
    const [step1NeedsTfa, setStep1NeedsTfa] = useState(false);

    // Step 2: 2FA, confirmed in place.
    const [tfaState, setTfaState] = useState<TfaState>('checking');
    // True only when a code was confirmed in this wizard. The status read that follows (the new 2FA session re-runs
    // it) then reports 2FA on too, but that must not turn "turned on here" into "already on": the backup codes and
    // the kit exist only for 2FA turned on here, and the node keeps only their hashes.
    const [tfaTurnedOnHere, setTfaTurnedOnHere] = useState(false);
    const [tfaStatusAttempt, setTfaStatusAttempt] = useState(0);
    const [tfaError, setTfaError] = useState<string | null>(null);
    const [tfaSetup, setTfaSetup] = useState<{ qrDataUrl?: string; formattedSecret: string; backupCodes: string[] } | null>(null);
    const [tfaCode, setTfaCode] = useState('');
    const [kitDownloaded, setKitDownloaded] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const loadTfaStatus = async () => {
            if (!activeNode?.url) return;
            try {
                const res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/2fa/status'), {
                    method: 'GET',
                    headers: buildAdminHeaders(activeNode.adminPassword, effectiveTfaToken),
                });
                if (cancelled) return;
                const data = await res.json().catch(() => ({} as Record<string, unknown>));
                if (cancelled) return;
                // Only a state still waiting on this answer takes it; one the operator has moved on keeps its own.
                if (res.ok && data && typeof data.totpEnabled === 'boolean') {
                    setTfaState((s) => (s === 'checking' || s === 'unknown' ? (data.totpEnabled ? 'on' : 'off') : s));
                } else if (res.status === 401 && data?.totpRequired) {
                    // The node refused the password alone because 2FA is on: that is its answer.
                    setTfaState((s) => (s === 'checking' || s === 'unknown' ? 'on' : s));
                } else {
                    setTfaState((s) => (s === 'checking' ? 'unknown' : s));
                }
            } catch {
                if (!cancelled) setTfaState((s) => (s === 'checking' ? 'unknown' : s));
            }
        };
        loadTfaStatus();
        return () => { cancelled = true; };
    }, [activeNode?.id, activeNode?.url, activeNode?.adminPassword, effectiveTfaToken, tfaStatusAttempt]);

    const handleRetryTfaStatus = () => {
        setTfaState('checking');
        setTfaStatusAttempt((n) => n + 1);
    };

    // Step 3: First Enterprise & First Offer
    const [selectedPresetId, setSelectedPresetId] = useState<'food' | 'tools' | 'machinery'>('food');
    const [enterpriseName, setEnterpriseName] = useState(FIRST_ENTERPRISE_PRESETS[0].name);
    const [enterpriseAvatar, setEnterpriseAvatar] = useState(FIRST_ENTERPRISE_PRESETS[0].avatar);
    const [enterprisePurpose, setEnterprisePurpose] = useState(FIRST_ENTERPRISE_PRESETS[0].purpose);
    const [firstOfferTitle, setFirstOfferTitle] = useState(FIRST_ENTERPRISE_PRESETS[0].firstOfferTitle);
    const [firstOfferPrice, setFirstOfferPrice] = useState(String(FIRST_ENTERPRISE_PRESETS[0].firstOfferCredits));
    const [creatingEnterprise, setCreatingEnterprise] = useState(false);
    const [createdEnterprisePk, setCreatedEnterprisePk] = useState<string | null>(null);
    const [keeperAssigned, setKeeperAssigned] = useState(false);
    const [offerPosted, setOfferPosted] = useState(false);
    const [step3Errors, setStep3Errors] = useState<Step3Errors | null>(null);

    // The first keeper is a member the node lists as an owner. On a new server nobody has joined yet, so usually
    // there is none, and the wizard says so rather than appointing a key that is not a member. The genesis "Admin"
    // the server seeds for the first invites is an owner too, but nobody holds its key, so it is never the keeper.
    const keeperMember = (nodeData?.members || []).find(
        (m) => m.nodeRole === 'owner' && !m.isTreasury && m.invitedBy !== 'genesis' && (m.publicKey || m.pubkey)
    );
    const keeperPubkey = keeperMember ? String(keeperMember.publicKey || keeperMember.pubkey) : null;
    const keeperName = keeperMember
        ? String(keeperMember.name || keeperMember.callsign || `${(keeperPubkey || '').slice(0, 12)}…`)
        : null;

    // Step 4 is an explanation only: the commons fills from fees, never by hand, and this wizard moves no beans.
    const [commonsRead, setCommonsRead] = useState(false);

    // Step 5: Founding Invites
    const [foundingCards, setFoundingCards] = useState<GeneratedCard[]>([]);
    const [generatingInvites, setGeneratingInvites] = useState(false);
    const [foundingError, setFoundingError] = useState<string | null>(null);

    // Step 1: ask the node's public health route. Only a 2xx answer counts as reachable.
    const checkReachability = async (): Promise<{ ok: boolean; error: string | null }> => {
        setReachabilityStatus('checking');
        setReachError(null);
        let res: Response | null = null;
        try {
            res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/community/health'));
        } catch {
            res = null;
        }
        if (res && res.ok) {
            setReachabilityStatus('reachable');
            return { ok: true, error: null };
        }
        const error = res
            ? `It answered, but its health check failed (HTTP ${res.status}).`
            : 'Nothing answered.';
        setReachabilityStatus('error');
        setReachError(error);
        return { ok: false, error };
    };

    const handleVerifyReachability = async () => {
        await checkReachability();
    };

    const saveName = async (tfa: string | undefined): Promise<{ ok: boolean; error: string | null }> => {
        let res: Response | null = null;
        try {
            res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/update-identity'), {
                method: 'POST',
                headers: buildAdminHeaders(activeNode.adminPassword, tfa),
                body: JSON.stringify({
                    password: activeNode.adminPassword,
                    communityName: communityName.trim(),
                    callsign: diag?.callsign || 'node-genesis',
                }),
            });
        } catch {
            res = null;
        }
        if (res && res.ok) {
            setNameSaved(true);
            setSaveError(null);
            setStep1NeedsTfa(false);
            return { ok: true, error: null };
        }
        const body = res ? await res.json().catch(() => null) : null;
        setStep1NeedsTfa(!!res && res.status === 401 && !!body?.totpRequired);
        const error = !res ? 'no answer' : (body && typeof body.error === 'string' && body.error) || `HTTP ${res.status}`;
        setNameSaved(false);
        setSaveError(error);
        return { ok: false, error };
    };

    // `recheck` asks the node again even when an earlier check passed; Retry always does, so the step's status comes
    // from this attempt and never from a value read before it.
    const runStep1 = async (opts: { recheck?: boolean; tfa?: string } = {}): Promise<Step1Outcome> => {
        setSavingStep1(true);
        try {
            const reach = reachabilityStatus === 'reachable' && !opts.recheck
                ? { ok: true, error: null }
                : await checkReachability();
            const save = await saveName(opts.tfa ?? effectiveTfaToken);
            return { reachable: reach.ok, reachError: reach.error, saved: save.ok, saveError: save.error };
        } finally {
            setSavingStep1(false);
        }
    };

    // Moves on only when both the check and the save worked. Otherwise it says what failed and offers Retry and
    // "Continue anyway" (never block boot); the step then stays marked as not finished.
    const handleSaveStep1 = async (e: React.FormEvent) => {
        e.preventDefault();
        const outcome = await runStep1();
        if (outcome.reachable && outcome.saved) {
            setStep1Problem(false);
            setCurrentStep(2);
        } else {
            setStep1Problem(true);
        }
    };

    const finishStep1Attempt = (outcome: Step1Outcome) => {
        if (outcome.reachable && outcome.saved) {
            setStep1Problem(false);
            setCurrentStep(2);
        }
    };

    const handleRetryStep1 = async () => {
        finishStep1Attempt(await runStep1({ recheck: true }));
    };

    // 2FA is on and this session has no code: ask for one with the manager's 2FA prompt, then save again with the
    // session the node issued.
    const handleStep1TfaCode = async () => {
        if (!onRequestTfaCode) return;
        let token: string;
        try {
            token = await onRequestTfaCode();
        } catch {
            return; // cancelled: the step stays as it was
        }
        if (!token) return;
        setFreshTfaToken(token);
        finishStep1Attempt(await runStep1({ recheck: true, tfa: token }));
    };

    const step1Done = reachabilityStatus === 'reachable' && nameSaved;

    // Step 2: start 2FA. The node keeps the new secret pending until a code from it is confirmed.
    const handleStartTfa = async () => {
        setTfaError(null);
        setTfaState('starting');
        let res: Response | null = null;
        try {
            res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/2fa/setup'), {
                method: 'POST',
                headers: buildAdminHeaders(activeNode.adminPassword, effectiveTfaToken),
            });
        } catch {
            res = null;
        }
        if (res && res.ok) {
            const data = await res.json().catch(() => ({} as Record<string, unknown>));
            if (typeof data.secret === 'string' && data.secret) {
                setTfaSetup({
                    qrDataUrl: typeof data.qrDataUrl === 'string' ? data.qrDataUrl : undefined,
                    formattedSecret: (typeof data.formattedSecret === 'string' && data.formattedSecret) || data.secret,
                    backupCodes: Array.isArray(data.backupCodes) ? data.backupCodes.map(String) : [],
                });
                setTfaCode('');
                setTfaState('awaiting-code');
                return;
            }
        }
        setTfaError(res && !res.ok ? await errorFrom(res) : 'The node did not return a 2FA secret');
        setTfaState('off');
    };

    const handleConfirmTfa = async (e: React.FormEvent) => {
        e.preventDefault();
        const code = tfaCode.trim();
        if (!code) return;
        setTfaError(null);
        setTfaState('verifying');
        let res: Response | null = null;
        try {
            res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/2fa/verify'), {
                method: 'POST',
                headers: buildAdminHeaders(activeNode.adminPassword, effectiveTfaToken),
                body: JSON.stringify({ code }),
            });
        } catch {
            res = null;
        }
        const data = res ? await res.json().catch(() => ({} as Record<string, unknown>)) : {};
        if (res && res.ok && data.success === true && data.totpEnabled === true) {
            const token = (data.tfaSessionToken || data.sessionToken) as string | undefined;
            if (token) {
                setTfaSessionToken(activeNode.id, token);
                setFreshTfaToken(token);
            }
            setTfaCode('');
            setTfaTurnedOnHere(true);
            setTfaState('on');
            return;
        }
        setTfaError((typeof data.error === 'string' && data.error) || (res ? `HTTP ${res.status}` : 'The node could not be reached'));
        setTfaState('awaiting-code');
    };

    const tfaOnHere = tfaState === 'on' && tfaTurnedOnHere;
    const kitBackupCodes = tfaOnHere && tfaSetup ? tfaSetup.backupCodes : [];

    // Step 2: the recovery kit lists only things that work: this server's address, and — when 2FA was turned on
    // here — the backup codes the node just made active. Nothing in it is made up on this screen.
    const handleDownloadKit = () => {
        const payload = `=====================================================
BEANPOOL SERVER RECOVERY KIT
=====================================================
Server:         ${nodeBaseUrl || nodeHost}
Community:      ${communityName.trim() || '(no name saved)'}
Written:        ${new Date().toISOString()}

2FA BACKUP CODES (each works once, in place of an authenticator code)
${kitBackupCodes.map((c) => `  ${c}`).join('\n')}

NOT IN THIS FILE
- The admin password. It is the ADMIN_PASSWORD you set in .env, or the
  one the server made up on first start, in data/first-admin-password.txt
  until the password is changed.
- Owners' own keys. Each owner gets back into their account with the 12
  recovery words the BeanPool app showed them.

KEEP THIS FILE OFF THE SERVER (PRINTED, OR ON AN OFFLINE USB STICK).
=====================================================`;

        const blob = new Blob([payload], { type: 'text/plain;charset=utf-8' });
        if (typeof URL.createObjectURL === 'function') {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `beanpool-recovery-kit-${nodeHost.replace(/[^a-zA-Z0-9]/g, '_')}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            if (typeof URL.revokeObjectURL === 'function') {
                URL.revokeObjectURL(url);
            }
        }
        setKitDownloaded(true);
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

    // Step 3: create the enterprise, appoint its first keeper (when an owner has joined) and post its first offer.
    // Each part is reported as the node answered it. Retry repeats only the parts that failed, so it never makes a
    // second enterprise.
    const handleCreateFirstEnterprise = async (e: React.FormEvent) => {
        e.preventDefault();
        setCreatingEnterprise(true);
        const errors: Step3Errors = {};
        const reason = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback);
        try {
            let treasuryPk = createdEnterprisePk;
            if (!treasuryPk) {
                try {
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
                    if (!res || !res.publicKey) throw new Error('The node did not return the new enterprise');
                    treasuryPk = res.publicKey;
                    setCreatedEnterprisePk(treasuryPk);
                } catch (err: unknown) {
                    errors.create = reason(err, 'The node could not be reached');
                }
            }

            if (treasuryPk && keeperPubkey && !keeperAssigned) {
                try {
                    await assignTreasuryKeeper(activeNode.url, treasuryPk, keeperPubkey, activeNode.adminPassword, effectiveTfaToken);
                    setKeeperAssigned(true);
                } catch (err: unknown) {
                    errors.keeper = reason(err, 'The node could not be reached');
                }
            }

            if (treasuryPk && !offerPosted) {
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
                    setOfferPosted(true);
                } catch (err: unknown) {
                    errors.offer = reason(err, 'The node could not be reached');
                }
            }

            if (errors.create || errors.keeper || errors.offer) {
                setStep3Errors(errors);
            } else {
                setStep3Errors(null);
                setCurrentStep(4);
            }
        } finally {
            setCreatingEnterprise(false);
        }
    };

    const step3Done = !!createdEnterprisePk && offerPosted && (!keeperPubkey || keeperAssigned);

    // Step 5: Generate 3 founding invites with printable QR cards. Every card carries a code the node issued; when
    // the node refuses we stop and show its reason — a made-up code would be printed and fail at the door.
    const handleGenerateFoundingInvites = async () => {
        setGeneratingInvites(true);
        setFoundingError(null);
        const cards: GeneratedCard[] = [...foundingCards];
        try {
            while (cards.length < FOUNDING_INVITE_COUNT) {
                let code: string;
                try {
                    const res = await generateNodeInvite(
                        activeNode.url,
                        activeNode.adminPassword,
                        'trusted',
                        effectiveTfaToken
                    );
                    code = res.code;
                } catch (err: unknown) {
                    setFoundingError(err instanceof Error && err.message ? err.message : 'The node could not be reached');
                    break;
                }
                const url = `${nodeBaseUrl}/?invite=${encodeURIComponent(code)}`;
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
        onComplete();
    };

    // A step shows ✓ only when what it does really happened; a step passed without that shows ⚠.
    const stepDone: Record<number, boolean> = {
        1: step1Done,
        2: tfaState === 'on',
        3: step3Done,
        4: commonsRead,
        5: false,
    };

    const accessSecurityButton = onOpenAccessSecurity && (
        <button
            type="button"
            onClick={onOpenAccessSecurity}
            className="min-h-[48px] px-4 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all"
        >
            Open Access &amp; Security
        </button>
    );

    return (
        <div className="max-w-4xl mx-auto space-y-6 font-sans animate-fade-in py-4">
            {/* Wizard Header Progress Bar */}
            <div className="bg-nature-900/90 border border-nature-800 rounded-3xl p-6 shadow-xl space-y-4">
                <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                        <span className="text-xs font-bold uppercase tracking-wider text-terra-400">
                            First Run Cold-Start Wizard
                        </span>
                        <h2 className="text-xl font-black text-white m-0 tracking-tight flex items-center gap-2">
                            <span>Set Up Your Community Server</span>
                            <HelpLink screen="cold-start" />
                        </h2>
                    </div>
                    {onCancel && (
                        <button
                            type="button"
                            onClick={onCancel}
                            className="text-xs text-nature-400 hover:text-white transition-colors shrink-0"
                        >
                            Skip to Dashboard
                        </button>
                    )}
                </div>

                {/* Step indicator pills */}
                <div className="grid grid-cols-5 gap-2 pt-2">
                    {[
                        { num: 1, label: '1. Name & Check' },
                        { num: 2, label: '2. Owner & 2FA' },
                        { num: 3, label: '3. First Enterprise' },
                        { num: 4, label: '4. The Commons' },
                        { num: 5, label: '5. Founding Cards' },
                    ].map((step) => {
                        const isActive = currentStep === step.num;
                        const isPassed = currentStep > step.num;
                        const isDone = isPassed && stepDone[step.num];
                        const isUnfinished = isPassed && !stepDone[step.num];
                        return (
                            <div
                                key={step.num}
                                data-testid={`wizard-step-${step.num}`}
                                title={isUnfinished ? 'Not finished' : undefined}
                                className={`p-2.5 rounded-xl border text-center transition-all ${
                                    isActive
                                        ? 'bg-terra-500/20 border-terra-500/50 text-terra-300 font-bold'
                                        : isDone
                                        ? 'bg-nature-950 border-nature-800 text-emerald-400 font-semibold'
                                        : isUnfinished
                                        ? 'bg-nature-950 border-amber-800/60 text-amber-400 font-semibold'
                                        : 'bg-nature-950/50 border-nature-900 text-nature-500'
                                }`}
                            >
                                <span className="text-[11px] block truncate">
                                    {isDone ? `✓ ${step.label.slice(3)}` : isUnfinished ? `⚠ ${step.label.slice(3)}` : step.label}
                                </span>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* STEP 1: Name and check */}
            {currentStep === 1 && (
                <div className="bg-nature-900/80 border border-nature-800 rounded-3xl p-6 md:p-8 shadow-xl space-y-6">
                    <div>
                        <h3 className="text-lg font-black text-white m-0 flex items-center gap-2">
                            <span>📍</span>
                            <span>Step 1: Name &amp; Check Your Server</span>
                        </h3>
                        <p className="text-xs text-nature-400 m-0 mt-1">
                            Save your community's name, and check that your server answers at its public address.
                        </p>
                    </div>

                    <form onSubmit={handleSaveStep1} className="space-y-4 max-w-xl">
                        <div>
                            <label htmlFor="cold-start-community-name" className="block text-xs font-bold text-nature-300 mb-1">
                                Community Name
                            </label>
                            <input
                                id="cold-start-community-name"
                                type="text"
                                value={communityName}
                                onChange={(e) => setCommunityName(e.target.value)}
                                required
                                placeholder="e.g. Riverside Food Commons"
                                className="w-full min-h-[48px] bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-terra-500"
                            />
                        </div>

                        <div>
                            <span className="block text-xs font-bold text-nature-300 mb-1">Server Address</span>
                            <div className="flex flex-wrap gap-2 items-center">
                                <span className="flex-1 min-w-0 break-all bg-nature-950 border border-nature-800 rounded-xl px-3.5 py-2.5 text-sm text-nature-200 font-mono">
                                    {nodeHost}
                                </span>
                                <button
                                    type="button"
                                    onClick={handleVerifyReachability}
                                    disabled={reachabilityStatus === 'checking'}
                                    className="min-h-[48px] px-4 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all shrink-0"
                                >
                                    {reachabilityStatus === 'checking' ? 'Checking...' : 'Verify Reachable'}
                                </button>
                            </div>

                            {reachabilityStatus === 'reachable' && (
                                <div className="mt-2 text-xs text-emerald-400 flex items-center gap-1.5 font-medium">
                                    <span>✓</span>
                                    <span>Your server answered at {nodeHost}.</span>
                                </div>
                            )}
                        </div>

                        {(reachabilityStatus === 'error' || (step1Problem && saveError)) && (
                            <div role="alert" className="p-4 rounded-2xl bg-red-950/60 border border-red-800 space-y-3">
                                {reachabilityStatus === 'error' && (
                                    <div className="space-y-2">
                                        <h4 className="text-sm font-bold text-red-200 m-0 break-words">
                                            Your server did not answer at {nodeHost}
                                        </h4>
                                        <p className="text-xs text-red-100 m-0 break-words">{reachError}</p>
                                        <p className="text-xs text-red-100 m-0">Check that:</p>
                                        <ul className="text-xs text-red-100 m-0 pl-5 space-y-1 list-disc">
                                            <li>the server is running: <code>docker compose ps</code></li>
                                            <li>its log shows no errors: <code>docker compose logs beanpool-node</code></li>
                                            <li>the address points at this server, and has had time to spread</li>
                                            <li>your router or firewall lets connections through to the server</li>
                                        </ul>
                                    </div>
                                )}
                                {step1Problem && saveError && (
                                    <p className="text-xs text-red-100 m-0 break-words">
                                        Your community name was not saved. The node said: <strong>{saveError}</strong>
                                    </p>
                                )}
                                {step1Problem && step1NeedsTfa && (
                                    <p className="text-xs text-red-100 m-0 break-words">
                                        2FA is on for this server, so saving needs a code from your authenticator app.
                                    </p>
                                )}
                                {step1Problem && (
                                    <div className="flex flex-wrap gap-3">
                                        {step1NeedsTfa && onRequestTfaCode && (
                                            <button
                                                type="button"
                                                onClick={handleStep1TfaCode}
                                                disabled={savingStep1}
                                                className="min-h-[48px] px-5 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all disabled:opacity-50"
                                            >
                                                Enter 2FA code
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            onClick={handleRetryStep1}
                                            disabled={savingStep1}
                                            className="min-h-[48px] px-5 rounded-xl bg-red-800 hover:bg-red-700 text-xs font-bold text-white transition-all disabled:opacity-50"
                                        >
                                            {savingStep1 ? 'Trying...' : 'Retry'}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setCurrentStep(2)}
                                            className="min-h-[48px] px-5 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all"
                                        >
                                            Continue anyway →
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}

                        {!step1Problem && (
                            <div className="pt-4 flex justify-end">
                                <button
                                    type="submit"
                                    disabled={savingStep1 || !communityName.trim()}
                                    className="min-h-[48px] px-6 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all shadow-md disabled:opacity-50"
                                >
                                    {savingStep1 ? 'Saving...' : 'Next: Owner & 2FA →'}
                                </button>
                            </div>
                        )}
                    </form>
                </div>
            )}

            {/* STEP 2: Owner, 2FA and the recovery kit */}
            {currentStep === 2 && (
                <div className="bg-nature-900/80 border border-nature-800 rounded-3xl p-6 md:p-8 shadow-xl space-y-6">
                    <div>
                        <h3 className="text-lg font-black text-white m-0 flex items-center gap-2">
                            <span>🔑</span>
                            <span>Step 2: Owner &amp; Two-Factor Sign-In</span>
                        </h3>
                        <p className="text-xs text-nature-400 m-0 mt-1">
                            Turn on two-factor sign-in for these settings, and see how your phone becomes an owner.
                        </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        {/* Two-factor sign-in, confirmed in place */}
                        <div className="p-5 rounded-2xl bg-nature-950 border border-nature-800 space-y-3 min-w-0">
                            <h4 className="text-xs font-bold uppercase tracking-wider text-nature-300 m-0">
                                Two-factor sign-in
                            </h4>

                            {tfaState === 'on' ? (
                                <div className="p-3 rounded-xl bg-emerald-950/40 border border-emerald-800/80 text-xs text-emerald-300 font-semibold">
                                    ✓ 2FA is on. {tfaTurnedOnHere
                                        ? 'You turned it on here: signing in to these settings now needs a code from your authenticator app.'
                                        : 'The node says it was already on.'}
                                </div>
                            ) : (
                                <>
                                    {tfaState === 'checking' ? (
                                        <p className="text-xs text-nature-300 m-0 font-semibold">
                                            Checking whether 2FA is on...
                                        </p>
                                    ) : tfaState === 'unknown' ? (
                                        <div className="space-y-2">
                                            <p className="text-xs text-amber-300 m-0 font-semibold">
                                                Couldn't check whether 2FA is on.
                                            </p>
                                            <button
                                                type="button"
                                                onClick={handleRetryTfaStatus}
                                                className="w-full min-h-[48px] rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all"
                                            >
                                                Retry
                                            </button>
                                        </div>
                                    ) : (
                                        <p className="text-xs text-amber-300 m-0 font-semibold">
                                            2FA is not on yet.
                                        </p>
                                    )}
                                    {(tfaState === 'off' || tfaState === 'unknown' || tfaState === 'starting') && (
                                        <>
                                            <p className="text-[11px] text-nature-400 m-0">
                                                You'll need an authenticator app on your phone, such as Aegis, 2FAS or Google Authenticator.
                                            </p>
                                            <button
                                                type="button"
                                                onClick={handleStartTfa}
                                                disabled={tfaState === 'starting'}
                                                className="w-full min-h-[48px] rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all shadow-md disabled:opacity-50"
                                            >
                                                {tfaState === 'starting' ? 'Starting...' : 'Set up 2FA'}
                                            </button>
                                        </>
                                    )}
                                    {(tfaState === 'awaiting-code' || tfaState === 'verifying') && tfaSetup && (
                                        <form onSubmit={handleConfirmTfa} className="space-y-3">
                                            <p className="text-[11px] text-nature-400 m-0">
                                                Scan this with your authenticator app, or type the key in. Then enter the 6-digit code it shows.
                                            </p>
                                            {tfaSetup.qrDataUrl && (
                                                <div className="w-40 h-40 bg-white p-2 rounded-xl mx-auto">
                                                    <img src={tfaSetup.qrDataUrl} alt="Authenticator setup QR" className="w-full h-full block" />
                                                </div>
                                            )}
                                            <div className="font-mono text-xs text-white text-center break-all">
                                                {tfaSetup.formattedSecret}
                                            </div>
                                            <label htmlFor="cold-start-tfa-code" className="block text-xs font-bold text-nature-300">
                                                Code from your authenticator
                                            </label>
                                            <input
                                                id="cold-start-tfa-code"
                                                type="text"
                                                inputMode="numeric"
                                                autoComplete="one-time-code"
                                                value={tfaCode}
                                                onChange={(e) => setTfaCode(e.target.value)}
                                                placeholder="123456"
                                                className="w-full min-h-[48px] bg-nature-900 border border-nature-700 rounded-xl px-3.5 text-sm text-white font-mono focus:outline-none focus:border-terra-500"
                                            />
                                            <button
                                                type="submit"
                                                disabled={tfaState === 'verifying' || !tfaCode.trim()}
                                                className="w-full min-h-[48px] rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all shadow-md disabled:opacity-50"
                                            >
                                                {tfaState === 'verifying' ? 'Checking...' : 'Turn on 2FA'}
                                            </button>
                                        </form>
                                    )}
                                    {tfaError && (
                                        <div role="alert" className="p-3 rounded-xl bg-red-950/60 border border-red-800 text-xs text-red-100 break-words">
                                            2FA is not on. The node said: <strong>{tfaError}</strong>
                                        </div>
                                    )}
                                    <div className="pt-2 border-t border-nature-800 space-y-2">
                                        <p className="text-[11px] text-nature-400 m-0">
                                            You can also finish it later in Access &amp; Security.
                                        </p>
                                        {accessSecurityButton}
                                    </div>
                                </>
                            )}

                            {tfaOnHere && tfaSetup && tfaSetup.backupCodes.length > 0 && (
                                <div className="space-y-2">
                                    <p className="text-[11px] text-nature-300 m-0">
                                        Backup codes: each works once, in place of an authenticator code. Keep them off this computer.
                                    </p>
                                    <ul className="grid grid-cols-2 gap-1 font-mono text-xs text-white m-0 p-0 list-none">
                                        {tfaSetup.backupCodes.map((c) => (
                                            <li key={c} className="bg-nature-900 rounded px-2 py-1 text-center break-all">{c}</li>
                                        ))}
                                    </ul>
                                    <button
                                        type="button"
                                        onClick={handleDownloadKit}
                                        className="w-full min-h-[48px] rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all shadow-md"
                                    >
                                        💾 Download Recovery Kit (.txt)
                                    </button>
                                    {kitDownloaded && (
                                        <div className="p-3 rounded-xl bg-emerald-950/40 border border-emerald-800/80 text-[11px] text-emerald-300">
                                            Recovery kit downloaded. Print it or keep it on an offline USB stick, then delete it here.
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* How an owner links their key: the real way */}
                        <div className="p-5 rounded-2xl bg-nature-950 border border-nature-800 space-y-3 min-w-0">
                            <h4 className="text-xs font-bold uppercase tracking-wider text-nature-300 m-0">
                                Your phone as owner
                            </h4>
                            <p className="text-[11px] text-nature-400 m-0 leading-relaxed">
                                Right now the admin password is the only way into these settings. To manage them from your phone
                                with your own key instead:
                            </p>
                            <ol className="text-[11px] text-nature-300 m-0 pl-5 space-y-1.5 list-decimal leading-relaxed">
                                <li>Join the community in the BeanPool app with one of the founding invites from step 5.</li>
                                <li>
                                    Here in Settings, open <strong>People &amp; Safety → Owners &amp; admins</strong> and add
                                    yourself as an owner.
                                </li>
                                <li>
                                    In the app's Settings, tap <strong>Manage {communityName.trim() || 'your community'}</strong>.
                                    It opens these settings signed in with your key, with no password.
                                </li>
                            </ol>
                            <p className="text-[11px] text-nature-400 m-0 leading-relaxed">
                                Keep at least two owners, so losing one phone never locks the community out.
                            </p>
                        </div>
                    </div>

                    <div className="pt-4 flex items-center justify-between gap-3 border-t border-nature-800">
                        <button
                            type="button"
                            onClick={() => setCurrentStep(1)}
                            className="min-h-[48px] px-4 rounded-xl bg-nature-800 text-xs font-bold text-nature-300 hover:text-white"
                        >
                            ← Back
                        </button>
                        <button
                            type="button"
                            onClick={() => setCurrentStep(3)}
                            className="min-h-[48px] px-6 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all shadow-md disabled:opacity-50"
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
                            Choose a founding preset (food, tools, or machinery) and post the enterprise's first offer, which
                            the offer covenant asks for. A member who is already an owner becomes its first keeper.
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
                                    disabled={!!createdEnterprisePk}
                                    className={`min-h-[48px] p-4 rounded-2xl border text-left transition-all ${
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
                                        disabled={!!createdEnterprisePk}
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
                                    disabled={!!createdEnterprisePk}
                                    required
                                    className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-terra-500"
                                />
                            </div>
                        </div>

                        <div>
                            <span className="block text-xs font-bold text-nature-300 mb-1">First keeper</span>
                            {keeperName ? (
                                <div
                                    data-testid="cold-start-keeper"
                                    className="p-3 rounded-xl bg-nature-950 border border-nature-800 flex flex-wrap items-center justify-between gap-2 text-xs"
                                >
                                    <span className="font-semibold text-white break-all min-w-0">{keeperName}</span>
                                    <span className="px-2 py-0.5 rounded bg-nature-800 text-nature-300 text-[10px] font-bold">
                                        {keeperAssigned ? '✓ Keeper' : 'Owner, will be made keeper'}
                                    </span>
                                </div>
                            ) : (
                                <p data-testid="cold-start-keeper" className="p-3 rounded-xl bg-nature-950 border border-nature-800 text-xs text-nature-300 m-0 leading-relaxed">
                                    No keeper will be set. Nobody on this server is an owner yet. Once you have joined
                                    and made yourself an owner (step 2), add yourself as its keeper in Shared Projects &amp; Economy.
                                </p>
                            )}
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

                        {step3Errors && (
                            <div role="alert" className="p-4 rounded-2xl bg-red-950/60 border border-red-800 space-y-2 text-xs text-red-100">
                                {step3Errors.create && (
                                    <p className="m-0 break-words">
                                        The enterprise was not created. The node said: <strong>{step3Errors.create}</strong>
                                    </p>
                                )}
                                {createdEnterprisePk && (
                                    <p className="m-0 break-words text-nature-200">
                                        The enterprise {enterpriseName.trim()} was created.
                                    </p>
                                )}
                                {step3Errors.keeper && (
                                    <p className="m-0 break-words">
                                        {keeperName} was not made its keeper. The node said: <strong>{step3Errors.keeper}</strong>
                                    </p>
                                )}
                                {step3Errors.offer && (
                                    <p className="m-0 break-words">
                                        The first offer was not posted. The node said: <strong>{step3Errors.offer}</strong>
                                    </p>
                                )}
                                <div className="flex flex-wrap gap-3 pt-1">
                                    <button
                                        type="submit"
                                        disabled={creatingEnterprise}
                                        className="min-h-[48px] px-5 rounded-xl bg-red-800 hover:bg-red-700 text-xs font-bold text-white transition-all disabled:opacity-50"
                                    >
                                        {creatingEnterprise ? 'Trying...' : 'Retry'}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setCurrentStep(4)}
                                        className="min-h-[48px] px-5 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all"
                                    >
                                        Continue anyway →
                                    </button>
                                </div>
                            </div>
                        )}

                        <div className="pt-4 flex items-center justify-between gap-3 border-t border-nature-800">
                            <button
                                type="button"
                                onClick={() => setCurrentStep(2)}
                                className="min-h-[48px] px-4 rounded-xl bg-nature-800 text-xs font-bold text-nature-300 hover:text-white"
                            >
                                ← Back
                            </button>
                            {!step3Errors && (
                                <button
                                    type="submit"
                                    disabled={creatingEnterprise || !enterpriseName.trim()}
                                    className="min-h-[48px] px-6 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all shadow-md disabled:opacity-50"
                                >
                                    {creatingEnterprise ? 'Creating...' : 'Next: The Commons →'}
                                </button>
                            )}
                        </div>
                    </form>
                </div>
            )}

            {/* STEP 4: How the commons fills. An explanation only: no beans move here (NO DEMURRAGE SLIDER). */}
            {currentStep === 4 && (
                <div className="bg-nature-900/80 border border-nature-800 rounded-3xl p-6 md:p-8 shadow-xl space-y-6">
                    <div>
                        <h3 className="text-lg font-black text-white m-0 flex items-center gap-2">
                            <span>🏛️</span>
                            <span>Step 4: How the Commons Fills</span>
                        </h3>
                        <p className="text-xs text-nature-400 m-0 mt-1">
                            The commons is your community's shared pot of beans.
                        </p>
                    </div>

                    <div className="p-4 rounded-2xl bg-nature-950 border border-nature-800 space-y-3 max-w-xl">
                        <p className="text-sm font-bold text-white m-0">
                            A new community's commons starts at 0 beans.
                        </p>
                        <p className="text-xs text-nature-300 m-0 leading-relaxed">
                            Nobody can put beans into it by hand, and this step moves none. It fills as the community trades:
                        </p>
                        <ul className="text-xs text-nature-300 m-0 pl-5 space-y-1.5 list-disc leading-relaxed">
                            <li>a 1.5% market fee on every completed trade;</li>
                            <li>a small monthly circulation fee on balances above 200 beans;</li>
                            <li>an enterprise's beans above its working-capital ceiling;</li>
                            <li>members who leave with beans to spare.</li>
                        </ul>
                        <p className="text-xs text-nature-300 m-0 leading-relaxed">
                            Beans leave it only through Decisions the members vote on: grants to enterprises, hardship
                            grants, and writing off debts.
                        </p>
                    </div>

                    {/* Protocol Invariant Callout per settings-ia §6 */}
                    <div className="p-4 rounded-2xl bg-nature-950/70 border border-nature-800/80 space-y-2 max-w-xl">
                        <span className="text-xs font-bold text-white flex items-center gap-1.5">
                            <span>⚖️</span>
                            <span>Fees are protocol rules</span>
                        </span>
                        <p className="text-[11px] text-nature-300 m-0 leading-relaxed">
                            Under <strong>the-commons.md §3.6 and settings-ia §6</strong>, changing them is a binding
                            community Decision (one member, one vote, 60% threshold). There is no admin setting that
                            silently changes money.
                        </p>
                    </div>

                    <div className="pt-4 flex items-center justify-between border-t border-nature-800 max-w-xl">
                        <button
                            type="button"
                            onClick={() => setCurrentStep(3)}
                            className="min-h-[48px] px-4 rounded-xl bg-nature-800 text-xs font-bold text-nature-300 hover:text-white"
                        >
                            ← Back
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                setCommonsRead(true);
                                setCurrentStep(5);
                            }}
                            className="min-h-[48px] px-6 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all shadow-md"
                        >
                            Next: Founding Invites →
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

                    {foundingError && !generatingInvites && (
                        <div role="alert" className="p-5 rounded-2xl bg-red-950/60 border border-red-800 space-y-3">
                            <h4 className="text-sm font-bold text-red-200 m-0 break-words">
                                {foundingCards.length === 0
                                    ? 'No founding invites were made'
                                    : `Only ${foundingCards.length} of ${FOUNDING_INVITE_COUNT} founding invites were made`}
                            </h4>
                            <p className="text-xs text-red-100 m-0 break-words">
                                The node said: <strong>{foundingError}</strong>
                            </p>
                            <p className="text-xs text-red-200/80 m-0 break-words">
                                {foundingCards.length === 0
                                    ? 'Nothing here is safe to print. Try again, or finish setup now and make invites later under People → Invites.'
                                    : 'The cards below are real. Try again for the rest, or make them later under People → Invites.'}
                            </p>
                            <div className="flex flex-wrap gap-3">
                                <button
                                    type="button"
                                    onClick={handleGenerateFoundingInvites}
                                    className="min-h-[48px] px-5 rounded-xl bg-red-800 hover:bg-red-700 text-xs font-bold text-white transition-all"
                                >
                                    {foundingCards.length === 0
                                        ? 'Try again'
                                        : `Try again for the other ${FOUNDING_INVITE_COUNT - foundingCards.length}`}
                                </button>
                                {foundingCards.length === 0 && (
                                    <button
                                        type="button"
                                        onClick={handleFinishWizard}
                                        className="min-h-[48px] px-5 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all"
                                    >
                                        Finish setup without invites →
                                    </button>
                                )}
                            </div>
                        </div>
                    )}

                    {foundingCards.length === 0 ? (
                        !(foundingError && !generatingInvites) && (
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
                        )
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
                                        {foundingCards.length} founding invite{foundingCards.length === 1 ? '' : 's'} made by the node · each works once, for 30 days.
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
