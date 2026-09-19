/**
 * Settings → "Sign in on a computer": scan the QR on the node's /settings page in a browser, check the short code,
 * pass the phone's unlock, and that browser is signed in with your key. Owners and admins only (the entry is shown
 * only to them, and the node checks the live role again). utils/settings-signin.ts has the steps and the reasons.
 */
import React, { useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Modal, Linking, Alert, ScrollView, Keyboard } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useIdentity } from './IdentityContext';
import { useTheme } from './ThemeContext';
import { palette } from '../constants/colors';
import { anchorUrl as getAnchorUrl } from '../utils/node-post';
import { NO_DEVICE_LOCK_MESSAGE } from '../utils/node-admin';
import {
    readSigninScan, scanProblemMessage, lookupPairing, approveComputerSignin, declineComputerSignin, formatShortCode,
    type ApproveOutcome,
} from '../utils/settings-signin';
import type { SettingsSigninQr } from '@beanpool/core';
import { TotpCodeDialog, looksLikeTotpCode } from '../components/TotpCodeDialog';

type Found = { qr: SettingsSigninQr; host: string; browser: string };

export default function SettingsSigninScreen() {
    const { community } = useLocalSearchParams<{ community?: string }>();
    const communityName = (typeof community === 'string' && community.trim()) || 'your community';
    const { identity } = useIdentity();
    const { colors } = useTheme();
    const insets = useSafeAreaInsets();
    const [permission, requestPermission] = useCameraPermissions();

    const [checking, setChecking] = useState(false);
    const [found, setFound] = useState<Found | null>(null);
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(false);
    const [totp, setTotp] = useState<{ continueWith: (code: string) => Promise<ApproveOutcome>; wrongCode: boolean } | null>(null);
    const [code, setCode] = useState('');
    const locked = useRef(false); // one scan at a time: the camera reports the same code many times a second

    const resumeScanning = () => {
        setFound(null);
        setChecking(false);
        setTimeout(() => { locked.current = false; }, 600);
    };

    const problem = (title: string, message: string) => {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        Alert.alert(title, message, [{ text: 'OK', onPress: resumeScanning }], { cancelable: false });
    };

    const onScanned = async ({ data }: BarcodeScanningResult) => {
        if (locked.current || found || done) return;
        locked.current = true;
        setChecking(true);
        const appNode = await getAnchorUrl();
        const scan = readSigninScan(data, appNode);
        if (scan.kind !== 'ok') {
            const m = scanProblemMessage(scan);
            problem(m.title, m.message);
            return;
        }
        const look = await lookupPairing(scan.qr);
        if (look.kind !== 'ok') {
            problem(look.kind === 'gone' ? 'That code has run out' : "Couldn't check the code", look.message);
            return;
        }
        Haptics.selectionAsync().catch(() => {});
        setChecking(false);
        setFound({ qr: scan.qr, host: scan.qr.nodeUrl.replace(/^https?:\/\//, ''), browser: look.browser });
    };

    const handle = (out: ApproveOutcome) => {
        switch (out.kind) {
            case 'approved':
                setTotp(null);
                setCode('');
                setDone(true);
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
                return;
            case 'totp-required':
                setTotp({ continueWith: out.continueWith, wrongCode: out.wrongCode });
                setCode('');
                return;
            case 'no-device-lock':
                Alert.alert('Set a screen lock first', NO_DEVICE_LOCK_MESSAGE);
                return;
            case 'unlock-failed':
                return; // They cancelled, or the phone said no. The sheet stays for another try.
            case 'refused':
            case 'error':
                setTotp(null);
                Alert.alert("Couldn't sign in the computer", out.message, [{ text: 'OK', onPress: resumeScanning }]);
                return;
        }
    };

    const approve = async () => {
        if (!found || !identity || busy) return;
        setBusy(true);
        try {
            handle(await approveComputerSignin({ qr: found.qr, identity, communityName }));
        } finally {
            setBusy(false);
        }
    };

    const submitCode = async () => {
        if (!totp || busy || !looksLikeTotpCode(code)) return;
        // Dismiss before any Alert can follow: an Alert raised over an open keyboard inside a Modal is the
        // pattern memory keyboard-avoidance-pattern.md warns about (same as useManageNode's submitCode).
        Keyboard.dismiss();
        setBusy(true);
        try {
            handle(await totp.continueWith(code));
        } finally {
            setBusy(false);
        }
    };

    const decline = async () => {
        if (!found || !identity || busy) return;
        setBusy(true);
        try {
            await declineComputerSignin(found.qr, identity);
        } finally {
            setBusy(false);
            router.back();
        }
    };

    const close = (
        <Pressable
            onPress={() => router.back()}
            style={[styles.closeBtn, { top: insets.top + 8 }]}
            accessibilityRole="button"
            accessibilityLabel="Close"
            hitSlop={8}
        >
            <Text style={styles.closeText}>✕</Text>
        </Pressable>
    );

    if (!permission) {
        return <View style={[styles.center, { backgroundColor: '#000' }]}><ActivityIndicator size="large" color={palette.emerald500} /></View>;
    }

    if (!permission.granted) {
        return (
            <View style={[styles.center, { backgroundColor: colors.surface.app, paddingTop: insets.top + 56 }]}>
                {close}
                <Text style={[styles.title, { color: colors.text.heading }]}>📷 Camera needed</Text>
                <Text style={[styles.body, { color: colors.text.secondary }]}>
                    To sign in on a computer, BeanPool scans the code on the computer's screen.
                </Text>
                <Pressable
                    style={[styles.primaryBtn, { backgroundColor: colors.brand.primary }]}
                    onPress={permission.canAskAgain ? requestPermission : () => Linking.openSettings()}
                    accessibilityRole="button"
                >
                    <Text style={[styles.primaryText, { color: colors.text.inverse }]}>
                        {permission.canAskAgain ? 'Allow the camera' : 'Open phone settings'}
                    </Text>
                </Pressable>
            </View>
        );
    }

    return (
        <View style={{ flex: 1, backgroundColor: '#000' }}>
            <CameraView
                style={StyleSheet.absoluteFillObject}
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={found || done || checking ? undefined : onScanned}
            />
            <View style={styles.overlay} pointerEvents="none">
                <View style={styles.reticle} />
            </View>
            {close}
            <View style={[styles.instructions, { bottom: insets.bottom + 24 }]}>
                {checking
                    ? <ActivityIndicator color="#fff" />
                    : (
                        <Text style={styles.instructionText}>
                            On the computer, open {communityName}'s Settings and choose “Sign in with your phone”. Then point the camera at the code.
                        </Text>
                    )}
            </View>

            <Modal visible={!!found} transparent animationType="slide" onRequestClose={busy ? () => {} : resumeScanning}>
                <View style={styles.sheetBackdrop}>
                    <ScrollView
                        style={[styles.sheet, { backgroundColor: colors.surface.card, borderColor: colors.border.default }]}
                        contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 20 }}
                    >
                        {done ? (
                            <View style={{ alignItems: 'center' }} accessibilityLiveRegion="polite">
                                <Text style={{ fontSize: 40, marginBottom: 8 }} accessibilityElementsHidden>✅</Text>
                                <Text style={[styles.title, { color: colors.text.heading }]}>Signed in</Text>
                                <Text style={[styles.body, { color: colors.text.secondary }]}>
                                    The computer is now in {communityName}'s Settings, signed in as you. Sign out there when you're done.
                                </Text>
                                <Pressable style={[styles.primaryBtn, { backgroundColor: colors.brand.primary }]} onPress={() => router.back()} accessibilityRole="button">
                                    <Text style={[styles.primaryText, { color: colors.text.inverse }]}>Done</Text>
                                </Pressable>
                            </View>
                        ) : found ? (
                            <>
                                <Text style={[styles.title, { color: colors.text.heading }]} accessibilityRole="header">
                                    Sign in {communityName} Settings on that computer?
                                </Text>
                                <Text style={[styles.body, { color: colors.text.secondary }]}>
                                    Only if the computer in front of you shows this code:
                                </Text>
                                <Text style={[styles.code, { color: colors.text.heading }]} accessibilityLabel={`Code ${found.qr.shortCode.split('').join(' ')}`}>
                                    {formatShortCode(found.qr.shortCode)}
                                </Text>
                                <View style={[styles.infoBox, { borderColor: colors.border.default }]}>
                                    <Text style={[styles.infoLine, { color: colors.text.body }]}>Community: {found.host}</Text>
                                    <Text style={[styles.infoLine, { color: colors.text.body }]}>Computer: {found.browser}</Text>
                                    <Text style={[styles.infoLine, { color: colors.text.body }]}>As: {identity?.callsign || 'you'}</Text>
                                </View>
                                <Pressable
                                    style={[styles.primaryBtn, { backgroundColor: colors.brand.primary }, busy && { opacity: 0.7 }]}
                                    onPress={approve}
                                    disabled={busy}
                                    accessibilityRole="button"
                                    accessibilityHint="Asks for your phone's unlock, then signs the computer in"
                                    accessibilityState={{ busy, disabled: busy }}
                                >
                                    {busy ? <ActivityIndicator color={colors.text.inverse} /> : <Text style={[styles.primaryText, { color: colors.text.inverse }]}>Sign in</Text>}
                                </Pressable>
                                <Pressable style={styles.secondaryBtn} onPress={decline} disabled={busy} accessibilityRole="button">
                                    <Text style={[styles.secondaryText, { color: colors.feedback.danger.solid }]}>No, that's not my computer</Text>
                                </Pressable>
                                <Pressable style={styles.secondaryBtn} onPress={resumeScanning} disabled={busy} accessibilityRole="button">
                                    <Text style={[styles.secondaryText, { color: colors.text.secondary }]}>Scan again</Text>
                                </Pressable>
                            </>
                        ) : null}
                    </ScrollView>
                </View>
                <TotpCodeDialog
                    visible={!!totp}
                    communityName={communityName}
                    wrongCode={!!totp?.wrongCode}
                    busy={busy}
                    code={code}
                    onChangeCode={setCode}
                    onSubmit={submitCode}
                    onCancel={() => { setTotp(null); setCode(''); }}
                    submitLabel="Sign in"
                />
            </Modal>
        </View>
    );
}

const styles = StyleSheet.create({
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
    closeBtn: {
        position: 'absolute', left: 16, width: 48, height: 48, borderRadius: 24,
        backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', zIndex: 10,
    },
    closeText: { color: '#fff', fontSize: 20, fontWeight: '700' },
    overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
    reticle: { width: '70%', maxWidth: 260, aspectRatio: 1, borderRadius: 24, borderWidth: 3, borderColor: palette.emerald400 },
    instructions: {
        position: 'absolute', left: 16, right: 16, backgroundColor: 'rgba(24,24,27,0.88)',
        borderRadius: 16, padding: 16, minHeight: 48, justifyContent: 'center',
    },
    instructionText: { color: '#fff', fontSize: 15, lineHeight: 21, textAlign: 'center' },
    sheetBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.55)' },
    sheet: { maxHeight: '90%', borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, flexGrow: 0 },
    title: { fontSize: 19, fontWeight: '800', marginBottom: 8, textAlign: 'center' },
    body: { fontSize: 15, lineHeight: 21, textAlign: 'center', marginBottom: 12 },
    code: { fontSize: 32, fontWeight: '900', letterSpacing: 4, textAlign: 'center', marginVertical: 8, fontVariant: ['tabular-nums'] },
    infoBox: { borderWidth: 1, borderRadius: 12, padding: 12, marginVertical: 12, gap: 4 },
    infoLine: { fontSize: 14, lineHeight: 20 },
    primaryBtn: { minHeight: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20, marginTop: 8, alignSelf: 'stretch' },
    primaryText: { fontSize: 16, fontWeight: '800' },
    secondaryBtn: { minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, marginTop: 4 },
    secondaryText: { fontSize: 15, fontWeight: '700', textAlign: 'center' },
});
