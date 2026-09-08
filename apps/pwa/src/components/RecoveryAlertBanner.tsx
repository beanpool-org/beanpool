import { useEffect, useState, useCallback } from 'react';
import type { BeanPoolIdentity } from '../lib/identity';
import {
    getMyActiveRecoveryCollections,
    cancelRecoveryCollection,
} from '../lib/api';

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
 * RecoveryAlertBanner — urgent alert when someone is trying to recover the owner's account.
 *
 * Matches apps/native/components/RecoveryAlertBanner.tsx:
 * Polls POST /api/recovery/collect/mine on mount (and every 30s) to check for active
 * recovery sessions against this member's account.
 *
 * If any are open, renders a danger banner with:
 *   1. Warning text explaining what's happening
 *   2. A [Stop It Now] button that calls POST /api/recovery/collect/cancel
 */
export function RecoveryAlertBanner({ onStopSuccess, onActionTaken }: RecoveryAlertBannerProps = {}) {
    const [sessions, setSessions] = useState<RecoverySession[]>([]);
    const [loading, setLoading] = useState(true);
    const [stopping, setStopping] = useState(false);

    const checkAlerts = useCallback(async () => {
        try {
            const mineRes = await getMyActiveRecoveryCollections();
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
        } catch (e: any) {
            console.warn('[RecoveryAlert] Failed checking active collections:', e.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        checkAlerts();
        const interval = setInterval(checkAlerts, 30_000);
        return () => clearInterval(interval);
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

    if (loading && sessions.length === 0) {
        return null;
    }

    if (sessions.length === 0) {
        return null;
    }

    return (
        <div className="space-y-3 mb-4 w-full" role="region" aria-live="assertive">
            {/* DANGER BANNER: Own account being recovered */}
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
        </div>
    );
}

export default RecoveryAlertBanner;
