import React, { useState, useEffect, useCallback } from 'react';
import {
    issueRekeyCodeApi,
    cancelRekeyCodeApi,
    completeRekeyApi,
    fetchRekeyStatusApi,
    type RekeyStatusResponse,
} from '../../lib/node-client';
import { useTimeout } from '../../lib/use-timeout';
import { ModalBackdrop } from '../common/ModalBackdrop';

/** What the operator types to make a new code for a member who already moved to a new key. */
export const MOVE_AGAIN_WORDS = 'NEW CODE';

/** A pending code's time left, in words: "5 h 12 min left", "12 min left", or "Expired". */
export function rekeyTimeLeft(expiresAt: string, now: number = Date.now()): string {
    const ms = new Date(expiresAt).getTime() - now;
    if (!Number.isFinite(ms) || ms <= 0) return 'Expired';
    const totalMin = Math.max(1, Math.floor(ms / 60000));
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h > 0 ? `${h} h ${m} min left` : `${m} min left`;
}

export interface RekeyMemberWizardProps {
    member: {
        publicKey: string;
        callsign: string;
        status?: string;
        avatarUrl?: string;
    };
    nodeUrl: string;
    adminPassword?: string;
    tfaToken?: string;
    onSuccess?: (newPubkey: string) => void;
    onClose: () => void;
}

export function RekeyMemberWizard({
    member,
    nodeUrl,
    adminPassword,
    tfaToken,
    onSuccess,
    onClose,
}: RekeyMemberWizardProps) {
    const [step, setStep] = useState<1 | 2 | 3>(1);
    const [rekeyStatus, setRekeyStatus] = useState<RekeyStatusResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Checklist state
    const [checkPhysical, setCheckPhysical] = useState(false);
    const [checkLost, setCheckLost] = useState(false);
    const [checkInvalidateNotice, setCheckInvalidateNotice] = useState(false);

    // Issued code state
    const [issuedCode, setIssuedCode] = useState<string | null>(null);
    const [expiresAt, setExpiresAt] = useState<string | null>(null);
    const [copiedCode, setCopiedCode] = useState(false);
    const copiedCodeTimer = useTimeout();

    // New pubkey input
    const [newPubkey, setNewPubkey] = useState('');
    const [completing, setCompleting] = useState(false);

    // The node left an owner's or admin's pending code out: this phone session is past its step-up window (#1534).
    const [codeNeedsStepUp, setCodeNeedsStepUp] = useState(false);
    const [rereading, setRereading] = useState(false);

    // Opening the wizard only reads the member's re-key status; a code is made only by the "Make a re-key code" press,
    // and not before that read has answered (or failed), so the wizard knows whether the member already moved.
    const [statusChecked, setStatusChecked] = useState(false);
    const [typedConfirm, setTypedConfirm] = useState('');
    const [cancelling, setCancelling] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const [now, setNow] = useState(() => Date.now());

    const isChecklistComplete = checkPhysical && checkLost && checkInvalidateNotice;
    /** The member's latest finished re-key, newest first from the node: they already moved to a new key. */
    const lastMove = rekeyStatus?.history?.[0] ?? null;
    const typedConfirmOk = !lastMove || typedConfirm.trim().toUpperCase() === MOVE_AGAIN_WORDS;
    const mayMakeCode = isChecklistComplete && statusChecked && typedConfirmOk && !loading;

    const resetChecklist = () => {
        setCheckPhysical(false);
        setCheckLost(false);
        setCheckInvalidateNotice(false);
        setTypedConfirm('');
    };

    /** Reads the member's re-key status and shows a pending code, or asks for Manage again when it is held back. */
    const applyStatus = useCallback((status: RekeyStatusResponse) => {
        setRekeyStatus(status);
        const pending = status.pendingRequest;
        if (!pending) return;
        const isExpired = new Date(pending.expires_at).getTime() < Date.now();
        if (isExpired) return;
        setExpiresAt(pending.expires_at);
        setStep(2);
        setIssuedCode(pending.code ?? null);
        setCodeNeedsStepUp(!!pending.codeNeedsStepUp);
    }, []);

    useEffect(() => {
        let mounted = true;
        const checkExisting = async () => {
            try {
                const status = await fetchRekeyStatusApi(nodeUrl, member.publicKey, adminPassword, tfaToken);
                if (mounted && status) applyStatus(status);
            } catch {
                // Not blocking
            } finally {
                if (mounted) setStatusChecked(true);
            }
        };
        checkExisting();
        return () => {
            mounted = false;
        };
    }, [nodeUrl, member.publicKey, adminPassword, tfaToken, applyStatus]);

    // The time left on a pending code, kept current while it shows.
    useEffect(() => {
        if (step !== 2) return;
        const id = setInterval(() => setNow(Date.now()), 30000);
        return () => clearInterval(id);
    }, [step]);

    /** After Manage again: read the status once more, which now carries the code. */
    const handleReread = async () => {
        setRereading(true);
        setError(null);
        try {
            const status = await fetchRekeyStatusApi(nodeUrl, member.publicKey, adminPassword, tfaToken);
            applyStatus(status);
            if (status.pendingRequest?.codeNeedsStepUp) {
                setError("Still waiting: press Manage in the BeanPool app again (it asks for your phone's lock), then try again.");
            }
        } catch (err: any) {
            setError(err?.message || 'Failed to fetch re-key status');
        } finally {
            setRereading(false);
        }
    };

    const handleIssueCode = async () => {
        if (!mayMakeCode) return;
        setLoading(true);
        setError(null);
        setNotice(null);
        try {
            const res = await issueRekeyCodeApi(nodeUrl, member.publicKey, adminPassword, tfaToken);
            setIssuedCode(res.code);
            setCodeNeedsStepUp(false);
            setExpiresAt(res.expiresAt);
            setStep(2);
        } catch (err: any) {
            setError(err?.message || 'Failed to issue re-enrolment code');
        } finally {
            setLoading(false);
        }
    };

    /** Undoes the pending code on the node: the member's key works again and their status is put back. */
    const handleCancelCode = async () => {
        setCancelling(true);
        setError(null);
        try {
            const res = await cancelRekeyCodeApi(nodeUrl, member.publicKey, adminPassword, tfaToken);
            setIssuedCode(null);
            setCodeNeedsStepUp(false);
            setExpiresAt(null);
            setNewPubkey('');
            resetChecklist();
            setRekeyStatus((s) => (s ? { ...s, pendingRequest: null, isInvalidated: false, invalidatedInfo: null } : s));
            setNotice(`Code cancelled. @${member.callsign}'s key works again; their status is ${res.status}.${res.note ? ` ${res.note}` : ''}`);
            setStep(1);
        } catch (err: any) {
            setError(err?.message || 'Failed to cancel the re-key code');
        } finally {
            setCancelling(false);
        }
    };

    const handleCompleteRekey = async () => {
        const clean = newPubkey.trim().toLowerCase();
        if (!clean || !/^[0-9a-f]{64}$/.test(clean)) {
            setError('Please enter a valid 64-character hex public key');
            return;
        }
        if (!issuedCode) {
            setError('Re-enrolment code is missing');
            return;
        }

        setCompleting(true);
        setError(null);
        try {
            await completeRekeyApi(nodeUrl, member.publicKey, issuedCode, clean, adminPassword, tfaToken);
            setStep(3);
            onSuccess?.(clean);
        } catch (err: any) {
            setError(err?.message || 'Failed to complete re-keying');
        } finally {
            setCompleting(false);
        }
    };

    const handleCopy = () => {
        if (!issuedCode) return;
        navigator.clipboard?.writeText(issuedCode);
        setCopiedCode(true);
        copiedCodeTimer.schedule(() => setCopiedCode(false), 2000);
    };

    return (
        <ModalBackdrop onClose={onClose} className="fixed inset-0 overflow-y-auto bg-black/80 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-fade-in font-sans">
            <div className="m-auto bg-nature-950 border border-nature-800 rounded-3xl p-6 max-w-lg w-full space-y-6 shadow-2xl overflow-hidden relative">
                
                {/* Header */}
                <div className="flex items-start justify-between gap-3 lg:gap-0 border-b border-nature-800 pb-4">
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div className="w-10 h-10 shrink-0 rounded-2xl bg-amber-950/60 border border-amber-800/80 flex items-center justify-center text-xl">
                            🔑
                        </div>
                        <div className="min-w-0 flex-1">
                            <h3 className="text-lg font-bold text-white leading-tight break-words">
                                Re-Key Member (Lost Phone)
                            </h3>
                            <p className="text-xs text-nature-400 font-mono mt-0.5 break-all">
                                @{member.callsign} · {member.publicKey.slice(0, 10)}...
                            </p>
                        </div>
                    </div>
                    <button
                        aria-label="Close"
                        type="button"
                        onClick={onClose}
                        className="shrink-0 text-nature-400 hover:text-white p-1 rounded-lg transition-colors text-sm"
                    >
                        ✕
                    </button>
                </div>

                {/* Stepper indicator */}
                <div className="flex items-center justify-between text-xs font-mono border-b border-nature-800/60 pb-3">
                    <span className={step === 1 ? 'text-amber-400 font-bold' : 'text-nature-400'}>
                        1. In-Person Verification
                    </span>
                    <span className="text-nature-600">→</span>
                    <span className={step === 2 ? 'text-amber-400 font-bold' : 'text-nature-400'}>
                        2. Code & New Key
                    </span>
                    <span className="text-nature-600">→</span>
                    <span className={step === 3 ? 'text-emerald-400 font-bold' : 'text-nature-400'}>
                        3. Bound & Verified
                    </span>
                </div>

                {/* Error Banner */}
                {error && (
                    <div className="p-3 bg-red-950/90 border border-red-800/80 rounded-2xl text-xs text-red-200">
                        ⚠️ {error}
                    </div>
                )}

                {notice && (
                    <div data-testid="rekey-notice" className="p-3 bg-emerald-950/60 border border-emerald-800/80 rounded-2xl text-xs text-emerald-200 break-words">
                        ✓ {notice}
                    </div>
                )}

                {/* Step 1: Verification Checklist */}
                {step === 1 && (
                    <div className="space-y-4 text-xs">
                        {lastMove && (
                            <div data-testid="rekey-already-moved" className="p-3 bg-sky-950/40 border border-sky-800/60 rounded-2xl text-sky-100 space-y-1 break-words">
                                <span className="font-bold block">
                                    Already moved to {lastMove.new_pubkey.slice(0, 10)}… on {new Date(lastMove.completed_at || lastMove.performed_at).toLocaleDateString()}
                                </span>
                                <p className="text-[11px] leading-relaxed m-0">
                                    {lastMove.new_pubkey === member.publicKey.toLowerCase()
                                        ? `This is the key @${member.callsign} moved to. A new code stops it straight away and signs them out, so make one only if this phone is lost too.`
                                        : `@${member.callsign} already moved to a new key.`}
                                </p>
                            </div>
                        )}
                        <div className="p-3 bg-amber-950/30 border border-amber-800/50 rounded-2xl text-amber-200 space-y-1">
                            <span className="font-bold block">🛡️ Operator-Assisted Identity Verification</span>
                            <p className="text-[11px] leading-relaxed text-amber-300/90 m-0">
                                Re-keying atomically transfers the member's balance, trade history, trust badges, node roles, and keeperships to a new device. Because key recovery bypasses seed words, verify the member in person before proceeding.
                            </p>
                        </div>

                        <div className="space-y-3 bg-nature-900/60 border border-nature-800/80 p-4 rounded-2xl">
                            <label className="flex items-start gap-2.5 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={checkPhysical}
                                    onChange={(e) => setCheckPhysical(e.target.checked)}
                                    className="mt-0.5 rounded bg-nature-950 border-nature-700 text-amber-500 focus:ring-0"
                                />
                                <span className="text-nature-200 min-w-0 break-words">
                                    <strong>In-person identity confirmed:</strong> I have personally verified @{member.callsign} is the real account holder.
                                </span>
                            </label>

                            <label className="flex items-start gap-2.5 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={checkLost}
                                    onChange={(e) => setCheckLost(e.target.checked)}
                                    className="mt-0.5 rounded bg-nature-950 border-nature-700 text-amber-500 focus:ring-0"
                                />
                                <span className="text-nature-200 min-w-0 break-words">
                                    <strong>Device lost or replaced:</strong> Confirmed the previous device is lost, damaged, or decommissioned without seed phrase access.
                                </span>
                            </label>

                            <label className="flex items-start gap-2.5 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={checkInvalidateNotice}
                                    onChange={(e) => setCheckInvalidateNotice(e.target.checked)}
                                    className="mt-0.5 rounded bg-nature-950 border-nature-700 text-amber-500 focus:ring-0"
                                />
                                <span className="text-nature-200 min-w-0 break-words">
                                    <strong>Immediate invalidation:</strong> The old device key will be permanently invalidated and all existing web sessions revoked.
                                </span>
                            </label>
                        </div>

                        {lastMove && (
                            <label className="block space-y-1.5">
                                <span className="block text-nature-200 break-words">
                                    To make a new code anyway, type <strong className="font-mono text-amber-300">{MOVE_AGAIN_WORDS}</strong>:
                                </span>
                                <input
                                    type="text"
                                    value={typedConfirm}
                                    onChange={(e) => setTypedConfirm(e.target.value)}
                                    aria-label={`Type ${MOVE_AGAIN_WORDS} to make a new code`}
                                    autoCapitalize="characters"
                                    autoComplete="off"
                                    className="w-full bg-nature-900 border border-nature-700 rounded-xl px-3 py-2.5 text-xs text-white font-mono placeholder:text-nature-600 focus:outline-none focus:border-amber-500"
                                />
                            </label>
                        )}

                        <p className="text-[11px] text-nature-400 m-0 break-words">
                            {statusChecked
                                ? 'Nothing changes until you press Make a re-key code. You can cancel a code until it is used.'
                                : 'Checking this member’s re-key status…'}
                        </p>

                        <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
                            <button
                                type="button"
                                onClick={onClose}
                                className="shrink-0 px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-nature-200 font-semibold"
                            >
                                Close
                            </button>
                            <button
                                type="button"
                                disabled={!mayMakeCode}
                                onClick={handleIssueCode}
                                className={`px-4 py-2 rounded-xl font-bold transition-all shadow-lg ${
                                    mayMakeCode
                                        ? 'bg-amber-600 hover:bg-amber-500 text-white'
                                        : 'bg-nature-800 text-nature-500 cursor-not-allowed border border-nature-700'
                                }`}
                            >
                                {loading ? 'Making the code…' : 'Make a re-key code →'}
                            </button>
                        </div>
                    </div>
                )}

                {/* Step 2: Code & New Key Input */}
                {step === 2 && (
                    <div className="space-y-4 text-xs">
                        <div className="p-3 bg-red-950/30 border border-red-800/50 rounded-2xl text-red-300">
                            🔒 Old key has been invalidated and cannot perform transactions. Made by mistake? Cancel this code: the key works again.
                        </div>

                        {/* Display Code */}
                        <div className="bg-nature-900/90 border border-nature-700/80 p-4 rounded-2xl text-center space-y-2">
                            <span className="text-[11px] uppercase tracking-wider text-nature-400 font-mono font-bold block">
                                One-Time Re-enrolment Code
                            </span>
                            {issuedCode ? (
                            <div className="flex items-center justify-center gap-3">
                                <span className="text-2xl font-mono font-extrabold tracking-widest text-amber-300 bg-black/40 px-4 py-2 rounded-xl border border-amber-900/60">
                                    {issuedCode}
                                </span>
                                <button
                                    type="button"
                                    onClick={handleCopy}
                                    className="px-3 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-white font-mono text-[11px] font-semibold border border-nature-600"
                                >
                                    {copiedCode ? '✓ Copied' : 'Copy'}
                                </button>
                            </div>
                            ) : codeNeedsStepUp ? (
                            <div className="space-y-2" data-testid="rekey-code-needs-step-up">
                                <p className="text-[11px] leading-relaxed text-amber-200 m-0">
                                    Confirm it's you first: this code moves an owner's or admin's role to a new phone. Press Manage in the BeanPool app again (it asks for your phone's lock), then show the code here.
                                </p>
                                <button
                                    type="button"
                                    onClick={handleReread}
                                    disabled={rereading}
                                    className="px-3 py-2 rounded-xl bg-amber-700 hover:bg-amber-600 text-white text-[11px] font-semibold"
                                >
                                    {rereading ? 'Checking…' : 'Show the code'}
                                </button>
                            </div>
                            ) : (
                            <p className="text-[11px] leading-relaxed text-nature-300 m-0">
                                Only the person who issued this code, or an owner, can see it.
                            </p>
                            )}
                            {expiresAt && (
                                <p className={`text-[10px] m-0 ${
                                    new Date(expiresAt).getTime() < now ? 'text-amber-400 font-bold' : 'text-nature-400'
                                }`}>
                                    {new Date(expiresAt).getTime() < now
                                        ? '⚠️ Code has expired'
                                        : `${rekeyTimeLeft(expiresAt, now)} (until ${new Date(expiresAt).toLocaleString()})`}
                                </p>
                            )}
                        </div>

                        {/* Complete binding */}
                        <div className="space-y-2">
                            <label className="block font-bold text-nature-200">
                                Member's Replacement Public Key:
                            </label>
                            <input
                                type="text"
                                value={newPubkey}
                                onChange={(e) => setNewPubkey(e.target.value)}
                                placeholder="e.g. 64 hex characters from new device"
                                className="w-full bg-nature-900 border border-nature-700 rounded-xl px-3 py-2.5 text-xs text-white font-mono placeholder:text-nature-600 focus:outline-none focus:border-amber-500"
                            />
                            <p className="text-[11px] text-nature-400 m-0">
                                The member can also scan the code on their replacement phone, or paste their new device's public key here to bind immediately.
                            </p>
                        </div>

                        {/* Federation notice: plain explanation before committing */}
                        <div className="p-3 bg-nature-900/80 border border-nature-700/80 rounded-2xl space-y-1">
                            <span className="font-bold text-amber-300 block text-[11px] flex items-center gap-1.5">
                                🌐 Federation Limitation
                            </span>
                            <p className="text-[11px] leading-relaxed text-nature-300 m-0">
                                Trades with other villages will need re-linking. Peer nodes do not automatically receive the replacement key, so cross-village trust and settlement links involving this member must be updated on remote nodes.
                            </p>
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
                            <div className="flex flex-wrap items-center gap-2">
                                <button
                                    type="button"
                                    onClick={handleCancelCode}
                                    disabled={cancelling || completing}
                                    className="px-3 py-2 rounded-xl bg-red-900/80 hover:bg-red-800 text-red-100 text-xs font-semibold border border-red-800"
                                >
                                    {cancelling ? 'Cancelling…' : 'Cancel this code'}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setIssuedCode(null);
                                        setCodeNeedsStepUp(false);
                                        setExpiresAt(null);
                                        resetChecklist();
                                        setStep(1);
                                    }}
                                    className="px-3 py-2 rounded-xl bg-nature-800/80 hover:bg-nature-700 text-nature-300 text-xs font-semibold"
                                >
                                    ← Issue New Code
                                </button>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={onClose}
                                    className="shrink-0 px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-nature-200 font-semibold"
                                >
                                    Close
                                </button>
                                <button
                                    type="button"
                                    disabled={completing || !issuedCode || !newPubkey.trim() || Boolean(expiresAt && new Date(expiresAt).getTime() < Date.now())}
                                    onClick={handleCompleteRekey}
                                    className={`px-4 py-2 rounded-xl font-bold transition-all shadow-lg ${
                                        !completing && issuedCode && newPubkey.trim() && !(expiresAt && new Date(expiresAt).getTime() < Date.now())
                                            ? 'bg-amber-600 hover:bg-amber-500 text-white'
                                            : 'bg-nature-800 text-nature-500 cursor-not-allowed border border-nature-700'
                                    }`}
                                >
                                    {completing ? 'Transferring Records...' : 'Complete Re-Keying →'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Step 3: Success Confirmation */}
                {step === 3 && (
                    <div className="space-y-4 text-xs text-center py-2">
                        <div className="w-14 h-14 rounded-full bg-emerald-950/80 border border-emerald-700 flex items-center justify-center text-3xl mx-auto text-emerald-400">
                            ✓
                        </div>
                        <div className="space-y-1">
                            <h4 className="text-base font-bold text-white">Re-Keying Complete!</h4>
                            <p className="text-nature-300 text-xs">
                                All balance, trade history, roles, and keeperships for <strong className="text-white break-all">@{member.callsign}</strong> have been atomically transferred to the new device key.
                            </p>
                        </div>

                        <div className="p-3 bg-nature-900/80 border border-nature-800 rounded-2xl text-left space-y-1 font-mono text-[11px]">
                            <div className="flex justify-between">
                                <span className="text-nature-400">Old Public Key:</span>
                                <span className="text-red-300 line-through">{member.publicKey.slice(0, 16)}...</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-nature-400">New Public Key:</span>
                                <span className="text-emerald-300 font-bold">{newPubkey.slice(0, 16)}...</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-nature-400">Audit Status:</span>
                                <span className="text-nature-200 min-w-0 break-words">Recorded in rekey_audit_log & system_logs</span>
                            </div>
                        </div>

                        <button
                            type="button"
                            onClick={onClose}
                            className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold transition-all shadow-lg"
                        >
                            Done
                        </button>
                    </div>
                )}

            </div>
        </ModalBackdrop>
    );
}
