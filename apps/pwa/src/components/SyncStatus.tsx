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
import { SyncChip } from './SyncChip';

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
}

export function SyncStatus({ isMember: propIsMember, stacked }: SyncStatusProps = {}) {
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

                setIsHttpOnline(true);
                setIsMember(result.isMember);
            } catch {
                if (!cancelled) setIsHttpOnline(false);
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
    const effectiveIsMember = propIsMember !== undefined ? propIsMember : isMember;

    const statusMode = sync.connected
        ? (effectiveIsMember === false ? 'guest' : 'online')
        : (isHttpOnline && effectiveIsMember === true)
        ? 'online'
        : (isHttpOnline && effectiveIsMember === false)
        ? 'guest'
        : 'offline';

    const ago = sync.lastSyncTime && statusMode !== 'guest' ? formatTimeAgo(sync.lastSyncTime) : null;
    return <SyncChip mode={statusMode} ago={ago} pulsing={sync.connected} stacked={stacked} />;
}
