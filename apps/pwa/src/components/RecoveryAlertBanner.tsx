import { useEffect, useState, useCallback } from 'react';
import type { BeanPoolIdentity } from '../lib/identity';
import {
    getMyActiveRecoveryCollections,
    cancelRecoveryCollection,
    getPendingKeeperActions,
    type PendingKeeperAction,
} from '../lib/api';
import { IncomingRecoveryApprovalModal } from './IncomingRecoveryApprovalModal';

interface RecoverySession {
    collectionId: string;
    requester: string;
    createdAt: string;
    status: string;
}

export interface RecoveryAlertBannerProps {
    identity?: BeanPoolIdentity | null;
    onStopSuccess?: () => void;
    onActionTaken?: () => void;
}

/**
 * RecoveryAlertBanner — urgent alerts for account recovery:
 * 1. Account Owner Danger Banner: when an unauthorized device is recovering this member's account
 *    (backed by POST /api/recovery/collect/mine and cancelable via POST /api/recovery/collect/cancel).
 * 2. Trusted Keeper Alert Banner: when a friend has opened a recovery session and needs this member's
 *    approval as an enrolled keeper (backed by authenticated POST /api/recovery/approve-keeper/pending).
 *
 * Polling runs every 30s matching PWA background cadence, and automatically pauses when the browser
 * tab is hidden to avoid hammering the node.
 */
export function RecoveryAlertBanner({ identity, onStopSuccess, onActionTaken }: RecoveryAlertBannerProps = {}) {
    const [sessions, setSessions] = useState<RecoverySession[]>([]);
    const [keeperActions, setKeeperActions] = useState<PendingKeeperAction[]>([]);
    const [loading, setLoading] = useState(true);
    const [stopping, setStopping] = useState(false);
    const [selectedKeeperCollectionId, setSelectedKeeperCollectionId] = useState<string | null>(null);
    const [showKeeperModal, setShowKeeperModal] = useState(false);

    const checkAlerts = useCallback(async () => {
        try {
            const [mineRes, keeperRes] = await Promise.all([
                getMyActiveRecoveryCollections().catch(() => [] as any[]),
                getPendingKeeperActions().catch(() => [] as PendingKeeperAction[]),
            ]);

            if (Array.isArray(mineRes)) {
                const active = mineRes
                    .filter((c: any) => c.status === 'open')
                    .map((c: any) => ({
                        collectionId: c.collectionId,
                        requester: c.requester || '',
                        createdAt: c.startedAt || c.createdAt || new Date().toISOString(),
                        status: c.status || 'open',
                    }));
                setSessions(active);
            } else {
                setSessions([]);
            }

            setKeeperActions(Array.isArray(keeperRes) ? keeperRes : []);
        } catch (e: any) {
            console.warn('[RecoveryAlert] Failed checking recovery alerts:', e.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        let interval: ReturnType<typeof setInterval> | null = null;

        const startPolling = () => {
            if (!interval) {
                checkAlerts();
                interval = setInterval(checkAlerts, 30_000);
            }
        };

        const stopPolling = () => {
            if (interval) {
                clearInterval(interval);
                interval = null;
            }
        };

        const handleVisibilityChange = () => {
            if (document.hidden) {
                stopPolling();
            } else {
                startPolling();
            }
        };

        if (!document.hidden) {
            startPolling();
        }

        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => {
            stopPolling();
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [checkAlerts]);

    const handleStopIt = async () => {
        const confirmed = window.confirm(
            '🛑 Stop Recovery Attempt\n\n' +
            'This will cancel all active recovery sessions, preventing any further fragment releases.\n\n' +
            'Do this only if you did NOT start this recovery.'
        );
        if (!confirmed) return;

        setStopping(true);
        try {
            for (const session of sessions) {
                try {
                    await cancelRecoveryCollection(session.collectionId);
                } catch (e: any) {
                    console.warn(`[RecoveryAlert] Failed to cancel ${session.collectionId}:`, e.message);
                }
            }
            setSessions([]);
            onStopSuccess?.();
            onActionTaken?.();
            alert('✅ Recovery Stopped: All active recovery sessions have been cancelled.');
        } catch {
            alert('Failed to stop recovery. Please try again.');
        } finally {
            setStopping(false);
        }
    };

    if (loading && sessions.length === 0 && keeperActions.length === 0) {
        return null;
    }

    if (sessions.length === 0 && keeperActions.length === 0) {
        return null;
    }

    return (
        <div className="space-y-3 mb-4 w-full" role="region" aria-live="assertive">
            {/* DANGER BANNER: Own account being recovered */}
            {sessions.length > 0 && (
                <div className="bg-red-50 dark:bg-red-950/60 border-2 border-red-500/70 dark:border-red-600/80 rounded-2xl p-4 sm:p-5 shadow-md">
                    <div className="flex items-start gap-3">
                        <span className="text-2xl flex-shrink-0" aria-hidden="true">🚨</span>
                        <div className="flex-1 min-w-0">
                            <h4 className="text-sm sm:text-base font-extrabold text-red-900 dark:text-red-200 leading-snug">
                                Someone is recovering your account
                            </h4>
                            <p className="text-xs sm:text-sm text-red-800 dark:text-red-300 mt-1 leading-relaxed">
                                A device is trying to restore access to your account. If this is not you, stop it immediately.
                            </p>
                            <div className="text-[11px] text-red-600 dark:text-red-400 mt-1 font-medium">
                                {sessions.length} active session{sessions.length > 1 ? 's' : ''} • Started {new Date(sessions[0].createdAt).toLocaleString()}
                            </div>

                            <div className="mt-3">
                                <button
                                    type="button"
                                    onClick={handleStopIt}
                                    disabled={stopping}
                                    className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-bold text-xs sm:text-sm transition-colors shadow-sm cursor-pointer flex items-center justify-center gap-2"
                                >
                                    {stopping ? (
                                        <>
                                            <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                            <span>Stopping Recovery...</span>
                                        </>
                                    ) : (
                                        <span>🛑 Stop It Now</span>
                                    )}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* KEEPER BANNER: Friend requesting keeper approval */}
            {keeperActions.map((act) => (
                <div
                    key={act.collectionId}
                    className="bg-emerald-50 dark:bg-emerald-950/60 border-2 border-emerald-500/70 dark:border-emerald-600/80 rounded-2xl p-4 sm:p-5 shadow-md"
                >
                    <div className="flex items-start gap-3">
                        <span className="text-2xl flex-shrink-0" aria-hidden="true">🔑</span>
                        <div className="flex-1 min-w-0">
                            <h4 className="text-sm sm:text-base font-extrabold text-emerald-900 dark:text-emerald-200 leading-snug">
                                Recovery Approval Requested
                            </h4>
                            <p className="text-xs sm:text-sm text-emerald-800 dark:text-emerald-300 mt-1 leading-relaxed">
                                <span className="font-bold text-emerald-950 dark:text-emerald-100">{act.callsign || 'A friend'}</span> listed you as a trusted recovery keeper and needs your approval to restore their account on a new device.
                            </p>
                            <div className="text-[11px] text-emerald-700 dark:text-emerald-400 mt-1 font-medium">
                                {act.expiresAt ? `Expires ${new Date(act.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Pending your verification'}
                            </div>

                            <div className="mt-3">
                                <button
                                    type="button"
                                    onClick={() => {
                                        setSelectedKeeperCollectionId(act.collectionId);
                                        setShowKeeperModal(true);
                                    }}
                                    className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs sm:text-sm transition-colors shadow-sm cursor-pointer flex items-center justify-center gap-2"
                                >
                                    <span>Review & Release Piece</span>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            ))}

            {/* Inbound Keeper Approval Modal */}
            {selectedKeeperCollectionId && (
                <IncomingRecoveryApprovalModal
                    isOpen={showKeeperModal}
                    collectionId={selectedKeeperCollectionId}
                    identity={identity || null}
                    onClose={() => {
                        setShowKeeperModal(false);
                        setSelectedKeeperCollectionId(null);
                    }}
                    onApproved={() => {
                        setShowKeeperModal(false);
                        setSelectedKeeperCollectionId(null);
                        checkAlerts();
                        onActionTaken?.();
                    }}
                />
            )}
        </div>
    );
}

export default RecoveryAlertBanner;
