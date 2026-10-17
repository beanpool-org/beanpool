/**
 * SyncStatus — Highly visible sync indicator
 *
 * Shows connected/disconnected/guest state and "Last synced X ago"
 * so users know when their Pillar-Sync is complete before
 * leaving Wi-Fi range.
 */

import { useState, useEffect, useId, useReducer } from 'react';
import { onSyncChange, type SyncState } from '../lib/sync';
import { checkMembership } from '../lib/api';
import { loadIdentity } from '../lib/identity';
import { withJitter } from '../lib/jitter';
import { SyncChip } from './SyncChip';
import { statusReducer, INITIAL_SYNC_STATUS_STATE, type SyncStatusState } from '../lib/standing-refusal';

function formatTimeAgo(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
}

interface SyncStatusProps {
    isMember?: boolean | null;
    /** How long ago goes under the word (the mobile header, as on the phone), not beside it. */
    stacked?: boolean;
    /** The dot alone: the header is too narrow for the tab's title beside the words (HeaderControls' useDotOnlyChip). */
    dotOnly?: boolean;
}

export function SyncStatus({ isMember: propIsMember, stacked, dotOnly }: SyncStatusProps = {}) {
    const [sync, setSync] = useState<SyncState>({
        connected: false,
        lastSyncTime: null,
        merkleRoot: null,
        accountCount: 0,
    });
    const [statusState, dispatchStatus] = useReducer<SyncStatusState, any>(statusReducer, INITIAL_SYNC_STATUS_STATE);
    const [noteOpen, setNoteOpen] = useState(true);
    const noteId = useId();

    useEffect(() => {
        const unsub = onSyncChange((s) => {
            setSync(s);
            dispatchStatus({ type: 'ws_change', connected: s.connected });
        });
        return unsub;
    }, []);

    // Membership probe — frequent when the WebSocket is closed, slow when it is open.
    //
    // This deliberately does NOT suppress the probe entirely while connected. A browser
    // WebSocket whose NAT mapping has expired, or whose server vanished, accepts `send()` into
    // the OS buffer without throwing: `readyState` stays OPEN and `sync.connected` stays true.
    // There is no pong watchdog, so a dead socket reads as healthy indefinitely — and skipping
    // the probe would leave the indicator falsely green next to a "last synced 45m ago" that
    // contradicts it. A slow probe keeps it honest and still removes most of the requests:
    // one per two minutes instead of one per thirty seconds.
    const probeIntervalMs = sync.connected ? 120_000 : 30_000;

    useEffect(() => {
        let cancelled = false;
        let interval: ReturnType<typeof setInterval> | null = null;

        const probe = async () => {
            try {
                const identity = await loadIdentity();
                if (!identity || cancelled) return;
                const result = await checkMembership(identity.publicKey);
                if (cancelled) return;

                dispatchStatus({ type: 'probe_success', isMember: result.isMember });
            } catch (e) {
                if (!cancelled) {
                    dispatchStatus({ type: 'probe_error', error: e });
                }
            }
        };

        const startPolling = () => {
            if (interval) return;
            probe();
            interval = setInterval(probe, withJitter(probeIntervalMs));
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
            cancelled = true;
            stopPolling();
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [probeIntervalMs]);

    // Auto-update the "time ago" label (pauses when hidden)
    const [, setTick] = useState(0);
    useEffect(() => {
        let timer: ReturnType<typeof setInterval> | null = null;

        const startTimer = () => {
            if (!timer) {
                timer = setInterval(() => setTick((t) => t + 1), 10000);
            }
        };

        const stopTimer = () => {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
        };

        const handleVisibilityChange = () => {
            if (document.hidden) {
                stopTimer();
            } else {
                setTick((t) => t + 1);
                startTimer();
            }
        };

        if (!document.hidden) {
            startTimer();
        }

        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => {
            stopTimer();
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, []);

    // Resolve display state
    // If the WebSocket is OPEN, derive statusMode directly from socket state.
    // Fall back to HTTP probe state only when the socket is closed.
    // When probe encountered a standing refusal (private_preview or account_closed),
    // standing is definitely "not a member" (guest), regardless of stale member props.
    const effectiveIsMember = statusState.sentence != null
        ? false
        : (propIsMember !== undefined ? propIsMember : statusState.isMember);

    const statusMode = sync.connected
        ? (effectiveIsMember === false ? 'guest' : 'online')
        : (statusState.isHttpOnline && effectiveIsMember === true)
        ? 'online'
        : (statusState.isHttpOnline && effectiveIsMember === false)
        ? 'guest'
        : 'offline';

    const ago = sync.lastSyncTime && statusMode !== 'guest' ? formatTimeAgo(sync.lastSyncTime) : null;
    const note = statusState.sentence || null;
    const chip = <SyncChip mode={statusMode} ago={ago} pulsing={sync.connected} stacked={stacked} dotOnly={dotOnly} note={note} />;
    if (!note) return chip;

    // The node's sentence (a private preview, a closed account) shows by the chip, not only as its title: a touch screen
    // has no hover. It opens with the sentence, out of the header's flow (below the mobile header's chip, above the
    // sidebar's, at the foot of the page); a tap on the chip or on the sentence folds it away, the chip brings it back.
    return (
        <div style={{ position: 'relative' }}>
            <button
                type="button"
                onClick={() => setNoteOpen((open) => !open)}
                aria-expanded={noteOpen}
                aria-controls={noteId}
                style={{ display: 'block', padding: 0, border: 'none', background: 'none', font: 'inherit', color: 'inherit', textAlign: 'inherit', cursor: 'pointer' }}
            >
                {chip}
            </button>
            {noteOpen && (
                <p
                    id={noteId}
                    data-testid="sync-note"
                    onClick={() => setNoteOpen(false)}
                    style={{
                        position: 'absolute',
                        left: 0,
                        ...(stacked ? { top: 'calc(100% + 4px)' } : { bottom: 'calc(100% + 4px)' }),
                        zIndex: 20,
                        width: 'max-content',
                        maxWidth: 'min(16rem, calc(100vw - 1.5rem))',
                        margin: 0,
                        padding: '0.4rem 0.6rem',
                        borderRadius: '0.75rem',
                        background: 'var(--sync-guest-bg, #fffbeb)',
                        border: '1px solid var(--sync-guest, #d97706)',
                        color: 'var(--text-primary)',
                        fontSize: '0.75rem',
                        lineHeight: 1.35,
                        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.2)',
                    }}
                >
                    {note}
                </p>
            )}
        </div>
    );
}
