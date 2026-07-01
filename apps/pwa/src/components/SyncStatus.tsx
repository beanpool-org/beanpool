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
    const [isGuest, setIsGuest] = useState(false);

    useEffect(() => {
        const unsub = onSyncChange(setSync);
        return unsub;
    }, []);

    // Membership probe — check once on mount and when connection state changes
    useEffect(() => {
        if (!sync.connected) return;
        let cancelled = false;
        (async () => {
            try {
                const identity = await loadIdentity();
                if (!identity || cancelled) return;
                const result = await checkMembership(identity.publicKey);
                if (!cancelled) setIsGuest(!result.isMember);
            } catch {
                // Network error — don't change state
            }
        })();
        return () => { cancelled = true; };
    }, [sync.connected]);

    // Auto-update the "time ago" label
    const [, setTick] = useState(0);
    useEffect(() => {
        const timer = setInterval(() => setTick((t) => t + 1), 10000);
        return () => clearInterval(timer);
    }, []);

    // Resolve display state
    const isOnline = sync.connected && !isGuest;
    const isGuestMode = sync.connected && isGuest;
    const borderColor = isOnline ? 'rgba(16, 185, 129, 0.3)' 
        : isGuestMode ? 'rgba(217, 119, 6, 0.4)' 
        : 'rgba(239, 68, 68, 0.3)';
    const dotColor = isOnline ? '#10b981' : isGuestMode ? '#d97706' : '#ef4444';
    const labelColor = isOnline ? '#10b981' : isGuestMode ? '#d97706' : '#ef4444';
    const label = isOnline ? 'Online' : isGuestMode ? 'Guest' : 'Offline';

    return (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            padding: '0.3rem 0.75rem',
            borderRadius: '9999px',
            background: isGuestMode ? '#fffbeb' : 'var(--bg-card)',
            border: `1px solid ${borderColor}`,
            fontSize: '0.75rem',
            fontWeight: 500,
            transition: 'all 0.3s ease',
        }}>
            <span style={{
                width: '7px',
                height: '7px',
                borderRadius: '50%',
                background: dotColor,
                animation: sync.connected ? 'pulse 2s infinite' : 'none',
                flexShrink: 0,
            }} />
            <span style={{ color: labelColor, whiteSpace: 'nowrap' }}>
                {label}
            </span>
            {sync.lastSyncTime && !isGuestMode && (
                <span style={{ color: 'var(--text-faint)', fontSize: '0.7rem', whiteSpace: 'nowrap' }}>
                    {formatTimeAgo(sync.lastSyncTime)}
                </span>
            )}
        </div>
    );
}
