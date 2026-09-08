import { useState, useEffect } from 'react';
import type { BeanPoolIdentity } from '../lib/identity';
import {
    getInboundApprovalContext,
    approveInboundRecovery,
    type InboundApprovalContext,
} from '../lib/api';

export interface IncomingRecoveryApprovalModalProps {
    isOpen: boolean;
    collectionId: string | null;
    identity: BeanPoolIdentity | null;
    onClose: () => void;
    onApproved?: () => void;
}

export function IncomingRecoveryApprovalModal({
    isOpen,
    collectionId,
    identity,
    onClose,
    onApproved,
}: IncomingRecoveryApprovalModalProps) {
    const [loading, setLoading] = useState(false);
    const [approving, setApproving] = useState(false);
    const [errorMsg, setErrorMsg] = useState('');
    const [context, setContext] = useState<InboundApprovalContext | null>(null);
    const [approved, setApproved] = useState(false);

    useEffect(() => {
        function handleKeyDown(e: KeyboardEvent) {
            if (e.key === 'Escape' && !approving) {
                onClose();
            }
        }
        if (isOpen) {
            window.addEventListener('keydown', handleKeyDown);
            return () => window.removeEventListener('keydown', handleKeyDown);
        }
    }, [isOpen, approving, onClose]);

    useEffect(() => {
        if (!isOpen || !collectionId || !identity) return;
        setLoading(true);
        setErrorMsg('');
        setApproved(false);
        setContext(null);

        let active = true;
        getInboundApprovalContext(collectionId)
            .then((ctx) => {
                if (active) setContext(ctx);
            })
            .catch((e: any) => {
                if (active) {
                    setErrorMsg(e.message || 'Could not load recovery details.');
                }
            })
            .finally(() => {
                if (active) setLoading(false);
            });

        return () => {
            active = false;
        };
    }, [isOpen, collectionId, identity]);

    const handleApprove = async () => {
        if (!context || !identity) return;
        setApproving(true);
        setErrorMsg('');
        try {
            await approveInboundRecovery(context, identity);
            setApproved(true);
            onApproved?.();
        } catch (e: any) {
            setErrorMsg(e.message || 'Failed to approve recovery.');
        } finally {
            setApproving(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 sm:p-6 overflow-y-auto"
            onClick={() => !approving && onClose()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="approval-modal-title"
        >
            <div
                className="bg-white dark:bg-nature-900 rounded-2xl shadow-2xl max-w-md w-full p-5 sm:p-6 border border-nature-200 dark:border-nature-800 my-auto text-nature-900 dark:text-white"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center gap-2 mb-4">
                    <span className="text-2xl" aria-hidden="true">🛡️</span>
                    <h3 id="approval-modal-title" className="text-lg font-bold text-nature-950 dark:text-white">
                        Account Recovery Request
                    </h3>
                </div>

                {loading ? (
                    <div className="py-8 text-center flex flex-col items-center justify-center gap-3">
                        <div className="w-8 h-8 border-3 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                        <p className="text-sm text-nature-500 dark:text-nature-400">Loading recovery request...</p>
                    </div>
                ) : errorMsg && !context ? (
                    <div className="py-6 text-center flex flex-col items-center gap-3">
                        <span className="text-4xl" aria-hidden="true">⚠️</span>
                        <h4 className="text-base font-bold text-nature-900 dark:text-white">Unable to Load Request</h4>
                        <p className="text-sm text-red-600 dark:text-red-400 leading-relaxed max-w-xs" role="alert">
                            {errorMsg}
                        </p>
                        <button
                            type="button"
                            onClick={onClose}
                            className="mt-2 px-6 py-2.5 rounded-xl bg-nature-100 dark:bg-nature-800 text-nature-800 dark:text-nature-200 font-bold hover:bg-nature-200 dark:hover:bg-nature-700 transition-colors"
                        >
                            Close
                        </button>
                    </div>
                ) : approved ? (
                    <div className="py-6 text-center flex flex-col items-center gap-3">
                        <span className="text-4xl" aria-hidden="true">✅</span>
                        <h4 className="text-base font-bold text-emerald-600 dark:text-emerald-400">Recovery Approved!</h4>
                        <p className="text-sm text-nature-600 dark:text-nature-300 leading-relaxed max-w-sm">
                            You safely released your recovery piece for <strong className="text-nature-900 dark:text-white">{context?.callsign}</strong>. Once they collect their remaining pieces, they will be back in their account.
                        </p>
                        <button
                            type="button"
                            onClick={onClose}
                            className="mt-3 w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold transition-colors"
                        >
                            Done
                        </button>
                    </div>
                ) : (
                    <>
                        <div className="p-4 rounded-xl bg-nature-50 dark:bg-nature-950/60 border border-nature-200 dark:border-nature-800 mb-4">
                            <div className="text-base font-bold text-nature-900 dark:text-white">
                                {context?.callsign || 'A member'}
                            </div>
                            <div className="text-xs text-nature-500 dark:text-nature-400 mt-0.5">
                                is trying to recover their BeanPool account on a new device.
                            </div>
                        </div>

                        <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 mb-4">
                            <div className="flex items-center gap-1.5 text-amber-900 dark:text-amber-300 font-bold text-xs uppercase tracking-wider mb-1">
                                <span>⚠️</span> Security Check
                            </div>
                            <p className="text-xs text-amber-800 dark:text-amber-200/90 leading-relaxed">
                                Only tap <strong>Approve</strong> if you have personally spoken with <strong className="text-amber-950 dark:text-amber-100">{context?.callsign}</strong> (by phone or in person) and verified they are restoring their device.
                            </p>
                            <p className="text-xs text-amber-800 dark:text-amber-200/90 leading-relaxed mt-2 font-medium">
                                Never approve if you were asked via email or text message.
                            </p>
                        </div>

                        {context && !context.live && (
                            <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300 mb-4" role="alert">
                                This recovery session is no longer active ({context.reason || 'expired'}).
                            </div>
                        )}

                        {errorMsg && (
                            <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300 mb-4" role="alert">
                                {errorMsg}
                            </div>
                        )}

                        <div className="flex flex-col gap-2.5 mt-2">
                            <button
                                type="button"
                                onClick={handleApprove}
                                disabled={approving || !context || !context.live}
                                className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-sm transition-colors flex items-center justify-center gap-2"
                            >
                                {approving ? (
                                    <>
                                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                        <span>Approving...</span>
                                    </>
                                ) : (
                                    <span>Approve Recovery</span>
                                )}
                            </button>

                            <button
                                type="button"
                                onClick={onClose}
                                disabled={approving}
                                className="w-full py-2.5 rounded-xl border border-nature-200 dark:border-nature-700 text-nature-700 dark:text-nature-300 hover:bg-nature-50 dark:hover:bg-nature-800 font-medium text-xs transition-colors"
                            >
                                Decline / Cancel
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

export default IncomingRecoveryApprovalModal;
