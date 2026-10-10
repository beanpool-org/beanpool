/**
 * Settings → Your area (design DESIGN-global-sync-by-area §3.5), on a community that gives each member the listings
 * near their area (`features.nearbyListings`). Shows "About 10 km around <town or lat, lng>" or "Not set", with Clear,
 * and below it the signup's "Roughly where are you?" (components/AreaPicker.tsx) to set a new one, or Cancel. Both
 * write the signed `POST /api/community/me/area`; the current value is the node's (`GET /api/community/me`).
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, SafeAreaView, ScrollView, ActivityIndicator } from 'react-native';
import { router, ErrorBoundary } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';

export { ErrorBoundary };
import { useIdentity } from './IdentityContext';
import { useNodeProfile } from '../utils/use-node-profile';
import { AreaPicker } from '../components/AreaPicker';
import { describeArea, readMemberArea, recallAreaPlace, rememberAreaPlace, writeMemberArea, type MemberArea } from '../utils/member-area';
import { colors, palette } from '../constants/colors';

export default function YourAreaScreen() {
    const { identity } = useIdentity();
    const nodeProfile = useNodeProfile();
    const [url, setUrl] = useState<string | null>(null);
    // undefined: not read yet, or the node couldn't be asked.
    const [area, setArea] = useState<MemberArea | null | undefined>(undefined);
    const [place, setPlace] = useState<string | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [clearing, setClearing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Once the member has left, a save that answers late never goes back a second time (it would pop Settings too).
    const left = useRef(false);
    useEffect(() => () => { left.current = true; }, []);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const u = await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null);
            if (cancelled) return;
            setUrl(u);
            if (u && identity) {
                const [a, p] = await Promise.all([readMemberArea(u, identity), recallAreaPlace(u)]);
                if (cancelled) return;
                setArea(a);
                setPlace(p);
            }
            setLoaded(true);
        })();
        return () => { cancelled = true; };
    }, [identity?.publicKey]);

    const clear = async () => {
        if (!url || !identity) return;
        setClearing(true);
        setError(null);
        const result = await writeMemberArea(url, identity, null);
        setClearing(false);
        if (!result.ok) { setError(result.error); return; }
        await rememberAreaPlace(url, null);
        setArea(null);
        setPlace(null);
    };

    const current = !loaded ? 'Checking…' : area === undefined ? "Couldn't check right now." : describeArea(area, place);

    return (
        <SafeAreaView style={styles.container}>
            <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
                <View style={styles.card}>
                    <Text style={styles.label}>Your area</Text>
                    <Text style={styles.current} testID="your-area-current">{current}</Text>
                    {area && (
                        <Pressable
                            style={[styles.clearBtn, clearing && styles.disabled]}
                            disabled={clearing}
                            onPress={clear}
                            accessibilityRole="button"
                            accessibilityLabel="Clear your area"
                            testID="your-area-clear"
                        >
                            {clearing ? <ActivityIndicator color={palette.red600 || '#dc2626'} /> : <Text style={styles.clearText}>Clear</Text>}
                        </Pressable>
                    )}
                    {error && <Text style={styles.error}>{error}</Text>}
                </View>
                <View style={styles.card}>
                    <AreaPicker
                        url={url}
                        identity={identity}
                        features={nodeProfile?.features}
                        skipLabel="Cancel"
                        onSkip={() => router.back()}
                        onSaved={async (_a, placeName) => {
                            if (left.current) return;
                            left.current = true;
                            if (url) await rememberAreaPlace(url, placeName);
                            router.back();
                        }}
                    />
                </View>
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface.page },
    scroll: { padding: 16, paddingBottom: 48 },
    card: { backgroundColor: colors.surface.card, borderRadius: 16, padding: 16, marginBottom: 12 },
    label: { fontSize: 13, fontWeight: '700', color: colors.text.secondary, textTransform: 'uppercase', marginBottom: 4 },
    current: { fontSize: 17, fontWeight: '700', color: colors.text.heading, marginBottom: 8 },
    clearBtn: { minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: palette.red600 || '#dc2626', alignItems: 'center', justifyContent: 'center', padding: 12 },
    clearText: { color: palette.red600 || '#dc2626', fontSize: 15, fontWeight: '700' },
    disabled: { opacity: 0.5 },
    error: { color: palette.red600 || '#dc2626', fontSize: 13, marginTop: 8, textAlign: 'center' },
});
