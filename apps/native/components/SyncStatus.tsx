import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { getLastSyncTime } from '../services/pillar-sync';
import { colors } from '../constants/colors';

function formatTimeAgo(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
}

export function SyncStatus() {
    const [lastSync, setLastSync] = useState<number | null>(null);
    const [now, setNow] = useState(Date.now());

    useEffect(() => {
        async function checkSync() {
            const time = await getLastSyncTime();
            setLastSync(time);
            setNow(Date.now()); // Force re-render even if time is identical
        }
        
        checkSync();
        const interval = setInterval(checkSync, 10000);
        return () => clearInterval(interval);
    }, []);

    // For the native UI, if we synced within the last 5 minutes, we consider it 'Online / Synced'.
    const isOnline = lastSync !== null && (now - lastSync) < 5 * 60 * 1000;

    return (
        <View style={[styles.container, isOnline ? styles.onlineBorder : styles.offlineBorder]}>
            <View style={[styles.dot, isOnline ? styles.onlineDot : styles.offlineDot]} />
            <View style={styles.textStack}>
                <Text style={[styles.text, isOnline ? styles.onlineText : styles.offlineText]}>
                    {isOnline ? 'Online' : 'Offline'}
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
    onlineDot: { backgroundColor: colors.brand.primary },
    offlineDot: { backgroundColor: colors.feedback.danger.solid },
    textStack: { flexDirection: 'column', justifyContent: 'center' },
    text: { fontSize: 11, fontWeight: '700', lineHeight: 12 },
    onlineText: { color: colors.brand.primary },
    offlineText: { color: colors.feedback.danger.solid },
    timeText: { color: colors.text.muted, fontSize: 9, fontWeight: '500', marginTop: 1 }
});
