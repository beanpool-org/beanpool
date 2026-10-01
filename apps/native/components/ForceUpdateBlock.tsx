import { useEffect, useState } from 'react';
import { AppState, BackHandler, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import appConfig from '../app.json';
import { useTheme } from '../app/ThemeContext';
import { bootClockMs } from '../modules/boot-clock';
import { checkCommunityForUpdate, createForceUpdateGate, STORE_URLS } from '../utils/force-update';

/**
 * The full-screen "Update required", mounted once at the root (app/_layout.tsx), outside the account: it covers the
 * whole app, the lock screen included, and has no way past but the store. When it goes up, and when it never does, is
 * utils/force-update.ts: only at a safe moment (a cold start, or back after five minutes away), and only when the
 * community says this build is below its floor and the store has one that meets it.
 *
 * A Modal, so it is above every screen and sheet, and a screen reader stays inside it. Android's back button leaves the
 * app rather than moving the screens hidden underneath.
 */

/** The phone's since-boot clock when it has one (counts while asleep); the wall clock otherwise, chosen once. */
const clock: () => number = bootClockMs() !== null ? () => bootClockMs() ?? Number.NaN : () => Date.now();

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal, headers: { 'Cache-Control': 'no-cache' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

function openStore() {
    const urls = Platform.OS === 'ios' ? STORE_URLS.ios : STORE_URLS.android;
    Linking.openURL(urls.app).catch(() => { Linking.openURL(urls.web).catch(() => {}); });
}

export default function ForceUpdateBlock() {
    const { colors } = useTheme();
    const [block, setBlock] = useState<{ version: string } | null>(null);

    useEffect(() => {
        if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;
        let mounted = true;
        const gate = createForceUpdateGate({
            now: clock,
            check: () => checkCommunityForUpdate({
                anchorUrl: () => AsyncStorage.getItem('beanpool_anchor_url'),
                fetchJson,
                localVersion: appConfig.expo.version,
                platform: Platform.OS,
            }),
            show: (next) => { if (mounted) setBlock(next); },
        });
        void gate.start(AppState.currentState);
        const sub = AppState.addEventListener('change', (next) => { void gate.appStateChanged(next); });
        return () => {
            mounted = false;
            sub.remove();
        };
    }, []);

    useEffect(() => {
        if (!block || Platform.OS !== 'android') return;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            BackHandler.exitApp();
            return true;
        });
        return () => sub.remove();
    }, [block]);

    if (!block) return null;
    const store = Platform.OS === 'ios' ? 'the App Store' : 'Google Play';

    return (
        <Modal visible animationType="fade" statusBarTranslucent onRequestClose={() => BackHandler.exitApp()}>
            <View style={[styles.fill, { backgroundColor: colors.surface.app }]}>
                <ScrollView contentContainerStyle={styles.scroll} accessibilityViewIsModal>
                    <View style={[styles.card, { backgroundColor: colors.surface.card, borderColor: colors.border.default }]}>
                        <Text style={styles.icon} accessibilityElementsHidden importantForAccessibility="no">⬆️</Text>
                        <Text accessibilityRole="header" style={[styles.title, { color: colors.text.heading }]}>
                            Update required
                        </Text>
                        <Text style={[styles.body, { color: colors.text.body }]}>
                            Your community needs a newer BeanPool than the one on this phone ({appConfig.expo.version}).
                            Version {block.version} is waiting in {store}.
                        </Text>
                        <Text style={[styles.body, { color: colors.text.secondary }]}>
                            Updating keeps your account and everything on this phone.
                        </Text>
                        <Pressable
                            onPress={openStore}
                            accessibilityRole="button"
                            accessibilityLabel={`Update BeanPool in ${store}`}
                            style={({ pressed }) => [styles.button, { backgroundColor: pressed ? colors.brand.dark : colors.brand.primary }]}
                        >
                            <Text style={[styles.buttonText, { color: colors.text.inverse }]}>Update</Text>
                        </Pressable>
                        <Text style={[styles.hint, { color: colors.text.secondary }]}>
                            Can't update? Ask the people who run your community.
                        </Text>
                    </View>
                </ScrollView>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    fill: { flex: 1 },
    scroll: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
    card: { width: '100%', maxWidth: 360, borderRadius: 20, borderWidth: 1, paddingVertical: 28, paddingHorizontal: 20, alignItems: 'center' },
    icon: { fontSize: 40, marginBottom: 12 },
    title: { fontSize: 22, fontWeight: '700', textAlign: 'center', marginBottom: 12 },
    body: { fontSize: 15, lineHeight: 22, textAlign: 'center', marginBottom: 12 },
    button: { alignSelf: 'stretch', minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingVertical: 12, paddingHorizontal: 16, marginTop: 8 },
    buttonText: { fontSize: 16, fontWeight: '700' },
    hint: { fontSize: 13, lineHeight: 18, textAlign: 'center', marginTop: 16 },
});
