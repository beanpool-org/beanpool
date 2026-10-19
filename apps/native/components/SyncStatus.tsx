import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, AppState, type AppStateStatus } from 'react-native';
import { getLastSyncTime } from '../services/pillar-sync';
import { colors } from '../constants/colors';
import { withJitter } from '../utils/jitter';
import { t, tn } from '@beanpool/core';

function formatTimeAgo(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return tn(seconds, '{n}s ago', '{n}s ago');
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return tn(minutes, '{n}m ago', '{n}m ago');
    const hours = Math.floor(minutes / 60);
    return tn(hours, '{n}h ago', '{n}h ago');
}

export function SyncStatus() {
    const [lastSync, setLastSync] = useState<number | null>(null);
    const [now, setNow] = useState(Date.now());

    useEffect(() => {
        let interval: ReturnType<typeof setInterval> | null = null;
        let cancelled = false;

        async function checkSync() {
            const time = await getLastSyncTime();
            if (cancelled) return; // resolved after unmount
            setLastSync(time);
            setNow(Date.now()); // Force re-render even if time is identical
        }

        const startPolling = () => {
            if (!interval) {
                checkSync();
                interval = setInterval(checkSync, withJitter(10000));
            }
        };

        const stopPolling = () => {
            if (interval) {
                clearInterval(interval);
                interval = null;
            }
        };

        const handleAppStateChange = (nextState: AppStateStatus) => {
            if (nextState === 'active') {
                startPolling();
            } else {
                stopPolling();
            }
        };

        if (AppState.currentState === 'active') {
            startPolling();
        }

        const sub = AppState.addEventListener('change', handleAppStateChange);

        return () => {
            cancelled = true;
            stopPolling();
            sub.remove();
        };
    }, []);

    // For the native UI, if we synced within the last 5 minutes, we consider it 'Online / Synced'.
    const isOnline = lastSync !== null && (now - lastSync) < 5 * 60 * 1000;

    return (
        <View
            style={[styles.container, isOnline ? styles.onlineBorder : styles.offlineBorder]}
            accessible={true}
            accessibilityLabel={isOnline
                ? (lastSync ? t('Sync status: Online, last synced {ago}', { ago: formatTimeAgo(lastSync) }) : t('Sync status: Online'))
                : (lastSync ? t('Sync status: Offline, last synced {ago}', { ago: formatTimeAgo(lastSync) }) : t('Sync status: Offline'))}
        >
            <View style={[styles.dot, isOnline ? styles.onlineDot : styles.offlineDot]} />
            <View style={styles.textStack}>
                <Text style={[styles.text, isOnline ? styles.onlineText : styles.offlineText]}>
                    {isOnline ? t('Online', undefined, 'sync') : t('Offline', undefined, 'sync')}
                </Text>
                {lastSync && (
                    <Text style={styles.timeText}>
                        {formatTimeAgo(lastSync)}
                    </Text>
                )}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        height: 32,
        width: 86,
        paddingHorizontal: 8,
        borderRadius: 20,
        backgroundColor: colors.surface.card,
        borderWidth: 1,
        borderStyle: 'solid'
    },
    onlineBorder: { borderColor: 'rgba(16, 185, 129, 0.3)' },
    offlineBorder: { borderColor: 'rgba(239, 68, 68, 0.3)' },
    dot: { width: 6, height: 6, borderRadius: 3, marginRight: 6 },
    onlineDot: { backgroundColor: colors.brand.fill },
    offlineDot: { backgroundColor: colors.feedback.danger.solid },
    textStack: { flexDirection: 'column', justifyContent: 'center' },
    text: { fontSize: 11, fontWeight: '700', lineHeight: 12 },
    onlineText: { color: colors.brand.primary },
    offlineText: { color: colors.feedback.danger.fg },
    timeText: { color: colors.text.muted, fontSize: 9, fontWeight: '500', marginTop: 1 }
});
