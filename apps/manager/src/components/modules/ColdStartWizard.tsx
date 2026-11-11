import React, { useState, useEffect } from 'react';
import { HelpLink } from '../manual/Manual';
import type { NodeProfile } from '../../lib/profiles';
import type { KeySession } from '../../lib/key-session';
import { Avatar } from '../common/Avatar';
import { OfferPhotoPicker } from '../common/OfferPhotoPicker';
import type { DiagnosticsResponse, NodeDataPayload } from '../../lib/node-client';
import {
    createNodeTreasury,
    assignTreasuryKeeper,
    seedTreasuryOffer,
    generateNodeInvite,
    resolveNodeApiUrl,
    buildAdminHeaders,
} from '../../lib/node-client';
import { nodeCredential } from '../../lib/profiles';
import { RecoveryCopiesLine, useRecoveryCopies } from './RecoveryCopiesLine';
import { beans } from '@beanpool/core';
import { parseBeans, beansRefusalText } from '../../lib/beans';

export interface ColdStartWizardProps {
    activeNode: NodeProfile;
    diag: DiagnosticsResponse | null;
    nodeData: NodeDataPayload | null;
    onComplete: () => void;
    onCancel?: () => void;
    /**
     * Who opened Settings with a key (lib/key-session.ts). An owner's key is already an owner, so step 2 tells them so;
     * an admin's key is pointed to the owners.
     */
    keySession?: KeySession | null;
}

interface GeneratedCard {
    code: string;
    url: string;
    qrUrl: string;
}

import { generateOfflineQrUrl } from '../../lib/qr';
export { generateOfflineQrUrl };

const FOUNDING_INVITE_COUNT = 3;

/** `firstOfferCredits`: what the price box starts with, in whole Beans as the owner reads it; read back by parseHundredths and sent as `price_c`. */
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

type Step1Outcome = { reachable: boolean; reachError: string | null; saved: boolean; saveError: string | null };

// `offerPhoto`: the first offer has no photo yet, so it was not sent (the node refuses a new Offer with none).
type Step3Errors = { create?: string; keeper?: string; offer?: string; offerPhoto?: boolean; offerPrice?: string };

async function errorFrom(res: Response | null): Promise<string> {
    if (!res) return 'no answer';
    const body = await res.json().catch(() => ({} as { error?: string }));
    return (body && typeof body.error === 'string' && body.error) || `HTTP ${res.status}`;
}

export function ColdStartWizard({
    activeNode,
    diag,
    nodeData,
    onComplete,
    onCancel,
    keySession,
}: ColdStartWizardProps) {
    // An owner who signed in with their phone key is already the owner. An admin's or moderator's key is told who adds owners.
    const isOwnerKey = keySession?.role === 'owner';
    const [currentStep, setCurrentStep] = useState<number>(1);

    const nodeBaseUrl = activeNode?.url ? activeNode.url.replace(/\/+$/, '') : '';
    const nodeHost = nodeBaseUrl.replace(/^https?:\/\//, '') || 'this server';
    // Where members' copies go, for step 5's line (vault rethink VR2): asked once as the wizard opens, so the steps that
    // follow make no request of their own for it.
    const copiesRule = useRecoveryCopies(activeNode.url);

    // Step 1: Name & check. The step is done only when the node answered its health check AND saved the name. The box
    // starts as the stored name: empty on a community with none, so the owner types one (the box is required). It never
    // starts as a stand-in: saved untouched, that was published as the community's name (#1935 finding 1).
    const [communityName, setCommunityName] = useState(diag?.communityName || '');
    const [reachabilityStatus, setReachabilityStatus] = useState<'unchecked' | 'checking' | 'reachable' | 'error'>('unchecked');
    const [reachError, setReachError] = useState<string | null>(null);
    const [nameSaved, setNameSaved] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [savingStep1, setSavingStep1] = useState(false);
    const [step1Problem, setStep1Problem] = useState(false);
    // Step 3: First Enterprise & First Offer
    const [selectedPresetId, setSelectedPresetId] = useState<'food' | 'tools' | 'machinery'>('food');
    const [enterpriseName, setEnterpriseName] = useState(FIRST_ENTERPRISE_PRESETS[0].name);
    const [enterpriseAvatar, setEnterpriseAvatar] = useState(FIRST_ENTERPRISE_PRESETS[0].avatar);
    const [enterprisePurpose, setEnterprisePurpose] = useState(FIRST_ENTERPRISE_PRESETS[0].purpose);
    const [firstOfferTitle, setFirstOfferTitle] = useState(FIRST_ENTERPRISE_PRESETS[0].firstOfferTitle);
    const [firstOfferPrice, setFirstOfferPrice] = useState(String(FIRST_ENTERPRISE_PRESETS[0].firstOfferCredits));
    const [firstOfferPhotos, setFirstOfferPhotos] = useState<string[]>([]);
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

    const saveName = async (): Promise<{ ok: boolean; error: string | null }> => {
        let res: Response | null = null;
        try {
            res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/update-identity'), {
                method: 'POST',
                headers: buildAdminHeaders(nodeCredential(activeNode)),
                body: JSON.stringify({
                    
                    // The name the owner typed, and nothing else: the callsign stays as stored (none on a new community)
                    // rather than one the owner never chose ("node-genesis", or the "admin" diagnostics once stood in with).
                    communityName: communityName.trim(),
                }),
            });
        } catch {
            res = null;
        }
        if (res && res.ok) {
            setNameSaved(true);
            setSaveError(null);
            return { ok: true, error: null };
        }
        const body = res ? await res.json().catch(() => null) : null;
        const error = !res ? 'no answer' : (body && typeof body.error === 'string' && body.error) || `HTTP ${res.status}`;
        setNameSaved(false);
        setSaveError(error);
        return { ok: false, error };
    };

    // `recheck` asks the node again even when an earlier check passed; Retry always does, so the step's status comes
    // from this attempt and never from a value read before it.
    const runStep1 = async (opts: { recheck?: boolean } = {}): Promise<Step1Outcome> => {
        setSavingStep1(true);
        try {
            const reach = reachabilityStatus === 'reachable' && !opts.recheck
                ? { ok: true, error: null }
                : await checkReachability();
            const save = await saveName();
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

    const step1Done = reachabilityStatus === 'reachable' && nameSaved;

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
                            // 250 Beans, as whole hundredths: the node takes `workingCapitalCeiling_c` (routes/treasury.ts).
                            workingCapitalCeiling_c: beans(250),
                            purpose: enterprisePurpose.trim() || undefined,
                        },
                        nodeCredential(activeNode)
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
                    await assignTreasuryKeeper(activeNode.url, treasuryPk, keeperPubkey, nodeCredential(activeNode));
                    setKeeperAssigned(true);
                } catch (err: unknown) {
                    errors.keeper = reason(err, 'The node could not be reached');
                }
            }

            // With no photo the offer is not sent: the node would refuse it. The enterprise and its keeper are still made,
            // and the step says what is missing; Retry, once a photo is chosen, posts only the offer. The same for a price
            // that isn't Beans to the cent: said here, in words, and never replaced by a price nobody typed.
            const price = parseBeans(firstOfferPrice);
            if (treasuryPk && !offerPosted && firstOfferPhotos.length === 0) {
                errors.offerPhoto = true;
            } else if (treasuryPk && !offerPosted && !price.ok) {
                errors.offerPrice = beansRefusalText(price.refusal);
            } else if (treasuryPk && !offerPosted && price.ok) {
                try {
                    await seedTreasuryOffer(
                        activeNode.url,
                        treasuryPk,
                        {
                            title: firstOfferTitle.trim(),
                            category: selectedPresetId === 'food' ? 'food' : 'tools',
                            // The price as typed, in Beans, to whole hundredths: the node takes `price_c` (15 Beans is 1500).
                            price_c: price.value,
                            photos: firstOfferPhotos,
                            description: `First community offer for ${enterpriseName}`,
                        },
                        nodeCredential(activeNode)
                    );
                    setOfferPosted(true);
                } catch (err: unknown) {
                    errors.offer = reason(err, 'The node could not be reached');
                }
            }

            if (errors.create || errors.keeper || errors.offer || errors.offerPhoto || errors.offerPrice) {
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
                        nodeCredential(activeNode),
                        'trusted'
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
        // An owner's key is already the owner: step 2 has nothing left to do.
        2: isOwnerKey,
        3: step3Done,
        4: commonsRead,
        5: false,
    };

    return (
        <div className="max-w-4xl mx-auto space-y-6 font-sans animate-fade-in py-4">
            {/* Wizard Header Progress Bar */}
            <div className="bg-nature-900/90 border border-nature-800 rounded-3xl p-6 shadow-xl space-y-4">
                <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                        <span className="text-xs font-bold uppercase tracking-wider text-bp-ink-terra">
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
                        { num: 2, label: '2. Owners' },
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
                                        ? 'bg-bp-chip-need-tint border-terra-500/50 text-bp-chip-need-ink font-bold'
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
                                {step1Problem && (
                                    <div className="flex flex-wrap gap-3">
                                        <button
                                            type="button"
                                            onClick={handleRetryStep1}
                                            disabled={savingStep1}
                                            className="min-h-[48px] px-5 rounded-xl bg-bp-danger-fill hover:bg-bp-danger-hover text-xs font-bold text-bp-danger-on transition-all disabled:opacity-50"
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
                                    className="min-h-[48px] px-6 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-bold text-bp-cta-on transition-all shadow-md disabled:opacity-50"
                                >
                                    {savingStep1 ? 'Saving...' : 'Next: Owners →'}
                                </button>
                            </div>
                        )}
                    </form>
                </div>
            )}

            {/* STEP 2: Owners */}
            {currentStep === 2 && (
                <div className="bg-nature-900/80 border border-nature-800 rounded-3xl p-6 md:p-8 shadow-xl space-y-6">
                    <div>
                        <h3 className="text-lg font-black text-white m-0 flex items-center gap-2">
                            <span>🔑</span>
                            <span>Step 2: Owners</span>
                        </h3>
                        <p className="text-xs text-nature-400 m-0 mt-1">
                            {isOwnerKey
                                ? "You signed in with your phone's key, so you are already the owner."
                                : 'You signed in with your phone\'s key as an admin. Owners are added by an owner.'}
                        </p>
                    </div>

                    {isOwnerKey ? (
                        /* Signed in with the owner's own key: nothing to link, only a second owner to add */
                        <div data-testid="owner-key-owner-card" className="p-5 rounded-2xl bg-nature-950 border border-nature-800 space-y-3 min-w-0">
                            <h4 className="text-xs font-bold uppercase tracking-wider text-nature-300 m-0">
                                Owners
                            </h4>
                            <p className="text-sm font-bold text-white m-0 break-words">
                                You are the owner.
                            </p>
                            <p className="text-[11px] text-nature-300 m-0 leading-relaxed">
                                Add a second owner soon: if this phone is lost, a second owner can still manage the community.
                            </p>
                            {/* The reason an owner's way back matters (vault rethink VR8, design §6 door 7). */}
                            <p className="text-[11px] text-nature-300 m-0 leading-relaxed" data-testid="owner-backups-reason">
                                Your key also unlocks this community&apos;s backups. Keep your words, and make a second owner, so one can bring the other back.
                            </p>
                            <p className="text-[11px] text-nature-400 m-0 leading-relaxed">
                                Once they have joined, open <strong>People &amp; Safety → Owners &amp; admins</strong> here in
                                Settings and add them as an owner.
                            </p>
                        </div>
                    ) : (
                        <div data-testid="admin-key-owner-card" className="p-5 rounded-2xl bg-nature-950 border border-nature-800 space-y-3 min-w-0">
                            <h4 className="text-xs font-bold uppercase tracking-wider text-nature-300 m-0">
                                Owners
                            </h4>
                            <p className="text-sm font-bold text-white m-0 break-words">
                                An owner of this community adds the owners.
                            </p>
                            <p className="text-[11px] text-nature-300 m-0 leading-relaxed">
                                They open <strong>People &amp; Safety → Owners &amp; admins</strong> here in Settings and add
                                the next owner. Keep at least two owners, so losing one phone never locks the community out.
                            </p>
                        </div>
                    )}

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
                            className="min-h-[48px] px-6 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-bold text-bp-cta-on transition-all shadow-md disabled:opacity-50"
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
                                <span className="text-[10px] text-bp-ink-terra font-mono">Rule 4 Covenant</span>
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
                                <label htmlFor="first-offer-price" className="block text-[11px] text-nature-400 mb-1">Price (Beans)</label>
                                <input
                                    id="first-offer-price"
                                    type="number"
                                    min="1"
                                    step="0.01"
                                    value={firstOfferPrice}
                                    onChange={(e) => setFirstOfferPrice(e.target.value)}
                                    required
                                    className="w-full bg-nature-900 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white font-mono"
                                />
                            </div>
                            <OfferPhotoPicker photos={firstOfferPhotos} onChange={setFirstOfferPhotos} labelClassName="block text-[11px] text-nature-400 mb-1" />
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
                                {step3Errors.offerPhoto && (
                                    <p className="m-0 break-words">
                                        The first offer was not posted: every Offer needs a photo. Add one under First Offer, then Retry.
                                    </p>
                                )}
                                {step3Errors.offerPrice && (
                                    <p className="m-0 break-words">
                                        The first offer was not posted: its price is Beans, to the cent. {step3Errors.offerPrice} Then Retry.
                                    </p>
                                )}
                                <div className="flex flex-wrap gap-3 pt-1">
                                    <button
                                        type="submit"
                                        disabled={creatingEnterprise}
                                        className="min-h-[48px] px-5 rounded-xl bg-bp-danger-fill hover:bg-bp-danger-hover text-xs font-bold text-bp-danger-on transition-all disabled:opacity-50"
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
                                    className="min-h-[48px] px-6 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-bold text-bp-cta-on transition-all shadow-md disabled:opacity-50"
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
                            className="min-h-[48px] px-6 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-bold text-bp-cta-on transition-all shadow-md"
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

                    {/* Before the first members join: where a sign-in they link keeps its copy (vault rethink VR2). */}
                    <RecoveryCopiesLine rule={copiesRule} />

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
                                    className="min-h-[48px] px-5 rounded-xl bg-bp-danger-fill hover:bg-bp-danger-hover text-xs font-bold text-bp-danger-on transition-all"
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
                                className="px-6 py-2.5 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-bold text-bp-cta-on transition-all shadow-md disabled:opacity-50"
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
                                            <span className="text-[10px] font-bold uppercase tracking-wider text-bp-ink-terra">
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
                                    className="px-5 py-2.5 rounded-xl bg-bp-commit-fill hover:bg-bp-commit-hover text-xs font-bold text-bp-commit-on transition-all shadow-md shrink-0"
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
