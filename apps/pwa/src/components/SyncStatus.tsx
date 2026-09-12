/**
 * SyncStatus — Highly visible sync indicator
 *
 * Shows connected/disconnected/guest state and "Last synced X ago"
 * so users know when their Pillar-Sync is complete before
 * leaving Wi-Fi range.
 */

import { useState, useEffect } from 'react';
import { onSyncChange, type SyncState } from '../lib/sync';
import { checkMembership } from '../lib/api';
import { loadIdentity } from '../lib/identity';
import { withJitter } from '../lib/jitter';

function formatTimeAgo(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
}

export function SyncStatus() {
    const [sync, setSync] = useState<SyncState>({
        connected: false,
        lastSyncTime: null,
        merkleRoot: null,
        accountCount: 0,
    });
    const [isHttpOnline, setIsHttpOnline] = useState<boolean | null>(null);
    const [isMember, setIsMember] = useState<boolean | null>(null);

    useEffect(() => {
        const unsub = onSyncChange(setSync);
        return unsub;
    }, []);

    // Membership probe — backed off to 30s + jitter, suspended when WS is connected, paused when hidden
    useEffect(() => {
        let cancelled = false;
        let interval: ReturnType<typeof setInterval> | null = null;

        const probe = async () => {
            try {
                const identity = await loadIdentity();
                if (!identity || cancelled) return;
                const result = await checkMembership(identity.publicKey);
                if (cancelled) return;

                setIsHttpOnline(true);
                setIsMember(result.isMember);
            } catch {
                if (!cancelled) setIsHttpOnline(false);
            }
        };

        const startPolling = () => {
            if (interval) return;
            probe();
            // Suspend recurring HTTP probe while the WebSocket is connected
            if (!sync.connected) {
                interval = setInterval(probe, withJitter(30_000));
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
            cancelled = true;
            stopPolling();
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [sync.connected]);

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
    // Online if either WebSocket or HTTP probe confirms connectivity and membership
    const isMemberConfirmed = isMember === true;
    const isReachable = sync.connected || isHttpOnline === true;

    const statusMode = (isReachable && isMemberConfirmed)
        ? 'online'
        : (isReachable && isMember === false)
        ? 'guest'
        : 'offline';

    const STATUS_CONFIG = {
        online: {
            borderColor: 'rgba(16, 185, 129, 0.3)',
            color: '#10b981',
            label: 'Online',
            bg: 'var(--bg-card)',
        },
        guest: {
            borderColor: 'rgba(217, 119, 6, 0.4)',
            color: '#d97706',
            label: 'Guest',
            bg: '#fffbeb',
        },
        offline: {
            borderColor: 'rgba(239, 68, 68, 0.3)',
            color: '#ef4444',
            label: 'Offline',
            bg: 'var(--bg-card)',
        },
    } as const;

    const config = STATUS_CONFIG[statusMode];

    return (
        <div
            role="status"
            aria-live="polite"
            aria-label={`Network status: ${config.label}${sync.lastSyncTime && statusMode !== 'guest' ? `, last synced ${formatTimeAgo(sync.lastSyncTime)}` : ''}`}
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.3rem 0.75rem',
                borderRadius: '9999px',
                background: config.bg,
                border: `1px solid ${config.borderColor}`,
                fontSize: '0.75rem',
                fontWeight: 500,
                transition: 'all 0.3s ease',
            }}
        >
            <span
                aria-hidden="true"
                style={{
                    width: '7px',
                    height: '7px',
                    borderRadius: '50%',
                    background: config.color,
                    animation: sync.connected ? 'pulse 2s infinite' : 'none',
                    flexShrink: 0,
                }}
            />
            <span style={{ color: config.color, whiteSpace: 'nowrap' }}>
                {config.label}
            </span>
            {sync.lastSyncTime && statusMode !== 'guest' && (
                <span style={{ color: 'var(--text-faint)', fontSize: '0.7rem', whiteSpace: 'nowrap' }}>
                    {formatTimeAgo(sync.lastSyncTime)}
                </span>
            )}
        </div>
    );
}
