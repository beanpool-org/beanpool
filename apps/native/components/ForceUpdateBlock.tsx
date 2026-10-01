import { useEffect, useState } from 'react';
import { AppState, BackHandler, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { FullWindowOverlay } from 'react-native-screens';
import appConfig from '../app.json';
import { useIdentity } from '../app/IdentityContext';
import { useTheme } from '../app/ThemeContext';
import { bootClockMs } from '../modules/boot-clock';
import { onCommunitySwitched } from '../utils/community-switch';
import { checkCommunityForUpdate, createForceUpdateGate, STORE_URLS } from '../utils/force-update';
import { hasMnemonic } from '../utils/identity';
import {
    accountSectionInFront, onAccountSectionInFront, otherCommunitiesOnPhone, switchFromUpdateBlock, type AccountSection,
    type OtherCommunity,
} from '../utils/update-block-escape';

/**
 * The full-screen "Update required", mounted once at the root (app/_layout.tsx), outside the sign-in: it covers the
 * whole app, the lock screen included, and has no way past it into the community that set the floor but the store.
 * When it goes up, and when it never does, is utils/force-update.ts: only at a safe moment (a cold start, back after
 * five minutes away, or a switch of community), and only when the community says this build is below its floor and the
 * store has one that meets it.
 *
 * It holds that one community only (utils/update-block-escape.ts): with other communities saved on the phone it offers
 * each of them, and with an account on the phone it always offers the member's 12 words and leaving the community
 * (Settings' own sections, which it steps aside for while one of them is in front).
 *
 * Above every screen and sheet, with a screen reader kept inside it. On Android a Modal, a window of its own; its back
 * button leaves the app rather than moving the screens hidden underneath. On iOS a FullWindowOverlay (react-native-screens),
 * a window of its own too: React Native's Modal is presented by the root view controller (RCTModalHostViewComponentView
 * presentViewController, RN 0.83), which cannot present while a sheet (post/[id], propose-project, …) is already up, so
 * a block raised after five minutes away with a sheet open would never have appeared.
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

/** Settings, on one of the account's sections (app/(tabs)/settings.tsx `params.section`); `open` makes each tap a new visit. */
function openAccountSection(section: AccountSection) {
    if (router.canDismiss()) router.dismissAll();
    router.navigate({ pathname: '/(tabs)/settings', params: { section, open: String(Date.now()) } });
}

export default function ForceUpdateBlock() {
    const { colors } = useTheme();
    const { identity } = useIdentity();
    const [block, setBlock] = useState<{ version: string } | null>(null);
    // One of Settings' account sections is in front: the block steps aside for it, and is back the moment it isn't.
    const [aside, setAside] = useState(accountSectionInFront);
    const [others, setOthers] = useState<OtherCommunity[]>([]);
    const [switching, setSwitching] = useState<string | null>(null);
    const [switchError, setSwitchError] = useState<string | null>(null);

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
        const stopSwitches = onCommunitySwitched(() => { void gate.communitySwitched(); });
        return () => {
            mounted = false;
            sub.remove();
            stopSwitches();
        };
    }, []);

    useEffect(() => onAccountSectionInFront(setAside), []);

    // The other communities on this phone, read each time the block goes up.
    useEffect(() => {
        if (!block) return;
        let current = true;
        setSwitchError(null);
        otherCommunitiesOnPhone().then((list) => { if (current) setOthers(list); });
        return () => { current = false; };
    }, [block]);

    const showing = !!block && !aside;

    useEffect(() => {
        if (!showing || Platform.OS !== 'android') return;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            BackHandler.exitApp();
            return true;
        });
        return () => sub.remove();
    }, [showing]);

    if (!block || aside) return null;
    const store = Platform.OS === 'ios' ? 'the App Store' : 'Google Play';

    const switchTo = async (c: OtherCommunity) => {
        if (switching) return;
        setSwitching(c.url);
        setSwitchError(null);
        try {
            // Takes the block down and asks `c` at once (utils/community-switch.ts); then through Welcome, as the
            // BeanPool sheet switches.
            await switchFromUpdateBlock(c.url);
            if (router.canDismiss()) router.dismissAll();
            router.replace('/welcome');
        } catch (e) {
            setSwitchError(`Couldn't switch to ${c.name}. ${e instanceof Error && e.message ? e.message : 'Please try again.'}`);
        } finally {
            setSwitching(null);
        }
    };

    const secondary = [styles.secondaryButton, { borderColor: colors.border.default, backgroundColor: colors.surface.app }];
    const screen = (
        <View style={[styles.fill, { backgroundColor: colors.surface.app }]} accessibilityViewIsModal>
            <ScrollView contentContainerStyle={styles.scroll}>
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

                {others.length > 0 && (
                    <View style={[styles.card, styles.next, { backgroundColor: colors.surface.card, borderColor: colors.border.default }]}>
                        <Text accessibilityRole="header" style={[styles.subtitle, { color: colors.text.heading }]}>
                            Use another community
                        </Text>
                        <Text style={[styles.small, { color: colors.text.secondary }]}>
                            This update is for this community only. Your other communities on this phone are still yours.
                        </Text>
                        {others.map((c) => (
                            <Pressable
                                key={c.url}
                                onPress={() => { void switchTo(c); }}
                                disabled={switching !== null}
                                accessibilityRole="button"
                                accessibilityLabel={`Use ${c.name}`}
                                accessibilityState={{ disabled: switching !== null, busy: switching === c.url }}
                                style={[...secondary, switching !== null && switching !== c.url && styles.dimmed]}
                            >
                                <Text style={[styles.secondaryText, { color: colors.text.heading }]}>
                                    {switching === c.url ? `Opening ${c.name}…` : c.name}
                                </Text>
                            </Pressable>
                        ))}
                        {switchError && (
                            <Text style={[styles.small, { color: colors.feedback.danger.solid, marginTop: 8 }]} accessibilityLiveRegion="polite">
                                {switchError}
                            </Text>
                        )}
                    </View>
                )}

                {identity && (
                    <View style={[styles.card, styles.next, { backgroundColor: colors.surface.card, borderColor: colors.border.default }]}>
                        <Text accessibilityRole="header" style={[styles.subtitle, { color: colors.text.heading }]}>
                            Your account
                        </Text>
                        <Text style={[styles.small, { color: colors.text.secondary }]}>
                            Your account is yours, not the community's. You can still see your 12 words, or leave this community.
                        </Text>
                        <Pressable onPress={() => openAccountSection('seed')} accessibilityRole="button" style={secondary}>
                            <Text style={[styles.secondaryText, { color: colors.text.heading }]}>
                                {hasMnemonic(identity) ? 'See my 12 words' : 'Add my 12 words to this phone'}
                            </Text>
                        </Pressable>
                        <Pressable onPress={() => openAccountSection('wipe')} accessibilityRole="button" style={secondary}>
                            <Text style={[styles.secondaryText, { color: colors.feedback.danger.solid }]}>
                                Leave this community
                            </Text>
                        </Pressable>
                    </View>
                )}
            </ScrollView>
        </View>
    );

    if (Platform.OS === 'ios') {
        return <FullWindowOverlay unstable_accessibilityContainerViewIsModal>{screen}</FullWindowOverlay>;
    }
    return (
        <Modal visible animationType="fade" statusBarTranslucent onRequestClose={() => BackHandler.exitApp()}>
            {screen}
        </Modal>
    );
}

const styles = StyleSheet.create({
    fill: { ...StyleSheet.absoluteFillObject },
    scroll: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
    card: { width: '100%', maxWidth: 360, borderRadius: 20, borderWidth: 1, paddingVertical: 28, paddingHorizontal: 20, alignItems: 'center' },
    icon: { fontSize: 40, marginBottom: 12 },
    title: { fontSize: 22, fontWeight: '700', textAlign: 'center', marginBottom: 12 },
    body: { fontSize: 15, lineHeight: 22, textAlign: 'center', marginBottom: 12 },
    button: { alignSelf: 'stretch', minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingVertical: 12, paddingHorizontal: 16, marginTop: 8 },
    buttonText: { fontSize: 16, fontWeight: '700' },
    hint: { fontSize: 13, lineHeight: 18, textAlign: 'center', marginTop: 16 },
    next: { marginTop: 16, alignItems: 'stretch' },
    subtitle: { fontSize: 17, fontWeight: '700', textAlign: 'center', marginBottom: 8 },
    small: { fontSize: 13, lineHeight: 18, textAlign: 'center', marginBottom: 4 },
    secondaryButton: { alignSelf: 'stretch', minHeight: 48, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 10, paddingHorizontal: 12, marginTop: 10 },
    secondaryText: { fontSize: 15, fontWeight: '600', textAlign: 'center' },
    dimmed: { opacity: 0.5 },
});
