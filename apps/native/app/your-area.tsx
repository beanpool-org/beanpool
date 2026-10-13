/**
 * Settings → Your area (design DESIGN-global-sync-by-area §3.5), on a community that gives each member the listings
 * near their area (`features.nearbyListings`). Shows "About 10 km around <town or lat, lng>" or "Not set", with Clear,
 * and below it the signup's "Roughly where are you?" (components/AreaPicker.tsx) to set a new one, or Cancel. Both
 * write the signed `POST /api/community/me/area`; the current value is the node's (`GET /api/community/me`).
 *
 * The root stack draws no headers, so this screen draws the standard one, as find-community.tsx does: ← Back and its
 * name, under react-native-safe-area-context's top inset (React Native's own SafeAreaView gives none on Android under
 * edge-to-edge), and the bottom inset under the scroll. Light or dark, like the signup wizard whose step it shows; the
 * header bar stays dark in both, so the status-bar icons stay light.
 */
import React, { useEffect, useRef, useState, useMemo } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { router, ErrorBoundary } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';

export { ErrorBoundary };
import { useIdentity } from './IdentityContext';
import { useNodeProfile } from '../utils/use-node-profile';
import { AreaPicker } from '../components/AreaPicker';
import { describeArea, readMemberArea, recallAreaPlace, rememberAreaPlace, writeMemberArea, type MemberArea } from '../utils/member-area';
import { palette, type AppColors } from '../constants/colors';
import { useOnboardingColors } from './ThemeContext';

export default function YourAreaScreen() {
    const { colors, dark } = useOnboardingColors();
    const styles = useMemo(() => makeStyles(colors, dark), [colors, dark]);
    const { identity } = useIdentity();
    const nodeProfile = useNodeProfile();
    const insets = useSafeAreaInsets();
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
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <StatusBar style="light" />
            <View style={styles.header}>
                <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Back">
                    <MaterialCommunityIcons name="arrow-left" size={26} color={colors.text.inverse} />
                </Pressable>
                <Text style={styles.headerTitle} numberOfLines={1} accessibilityRole="header">Your area</Text>
                <View style={styles.headerSpacer} />
            </View>
            <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: Math.max(insets.bottom, 16) + 32 }]} keyboardShouldPersistTaps="handled">
                <View style={styles.card}>
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
                            {clearing ? <ActivityIndicator color={dark ? colors.feedback.danger.fg : (colors.feedback.danger.fg)} /> : <Text style={styles.clearText}>Clear</Text>}
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

function makeStyles(colors: AppColors, dark: boolean) {
    return StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },
        header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, minHeight: 56, borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: dark ? colors.surface.card : colors.text.heading },
        backButton: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center' },
        headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: 'bold', color: colors.brand.primary, letterSpacing: 0.5, textTransform: 'uppercase' },
        headerSpacer: { width: 48 },
        scroll: { padding: 16 },
        card: { backgroundColor: colors.surface.card, borderRadius: 16, padding: 16, marginBottom: 12 },
        current: { fontSize: 17, fontWeight: '700', color: colors.text.heading, marginBottom: 8 },
        clearBtn: { minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: dark ? colors.feedback.danger.fg : (palette.red600 || '#dc2626'), alignItems: 'center', justifyContent: 'center', padding: 12 },
        clearText: { color: dark ? colors.feedback.danger.fg : (colors.feedback.danger.fg), fontSize: 15, fontWeight: '700' },
        disabled: { opacity: 0.5 },
        error: { color: dark ? colors.feedback.danger.fg : (colors.feedback.danger.fg), fontSize: 13, marginTop: 8, textAlign: 'center' },
    });
}
