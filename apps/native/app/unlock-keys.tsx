/**
 * "Take over or restore with this phone" (sealed-keys.md §5.2, §6.2; slice 6). An owner scans the QR on a standby's
 * Settings (or a server restoring a sealed backup), or opens the same thing as a `beanpool://unlock-keys?…` link, sees
 * which community, which server and what will happen, passes the phone's unlock, and the phone hands that server the
 * key to the community's locked keys — re-locked so only that server can read it. The phone never sees what is inside.
 * utils/takeover-unlock.ts has the steps and the reasons.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Modal, Linking, Alert, ScrollView } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { useIdentity } from './IdentityContext';
import { useTheme } from './ThemeContext';
import { palette } from '../constants/colors';
import { NO_DEVICE_LOCK_MESSAGE } from '../utils/node-admin';
import {
    readUnlockScan, unlockTextFromParams, scanProblemMessage, openedFromLinkWarning, lookupUnlock, approveUnlock, readLockPin,
    type UnlockLookup, type UnlockOutcome,
} from '../utils/takeover-unlock';
import type { OwnerUnlockQr } from '@beanpool/core';

type Found = { qr: OwnerUnlockQr; look: Extract<UnlockLookup, { kind: 'ok' }> };

function day(iso: string | undefined): string {
    if (!iso) return 'an unknown date';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function UnlockKeysScreen() {
    const params = useLocalSearchParams<Record<string, string>>();
    const communityName = (typeof params.community === 'string' && params.community.trim()) || 'your community';
    const { identity, isLoading } = useIdentity();
    const { colors } = useTheme();
    const insets = useSafeAreaInsets();
    const [permission, requestPermission] = useCameraPermissions();

    const [checking, setChecking] = useState(false);
    const [found, setFound] = useState<Found | null>(null);
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState<'takeover' | 'restore' | null>(null);
    const locked = useRef(false); // one scan at a time: the camera reports the same code many times a second
    const fromLink = unlockTextFromParams(params);

    const resumeScanning = () => {
        setFound(null);
        setChecking(false);
        setTimeout(() => { locked.current = false; }, 600);
    };

    const problem = (title: string, message: string) => {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        Alert.alert(title, message, [{ text: 'OK', onPress: fromLink ? () => router.back() : resumeScanning }], { cancelable: false });
    };

    const read = async (text: string) => {
        if (locked.current || found || done) return;
        locked.current = true;
        setChecking(true);
        const scan = readUnlockScan(text);
        if (scan.kind !== 'ok') {
            const m = scanProblemMessage(scan);
            problem(m.title, m.message);
            return;
        }
        if (!identity?.privateKey) {
            problem('No account on this phone', 'Sign in to your community on this phone first: the lock opens with your account.');
            return;
        }
        const pin = await readLockPin(AsyncStorage, identity.publicKey);
        const look = await lookupUnlock(scan.qr, identity, pin);
        if (look.kind !== 'ok') {
            problem(look.kind === 'gone' ? 'That code has run out' : look.kind === 'refused' ? "This phone won't open it" : "Couldn't check the code", look.message);
            return;
        }
        Haptics.selectionAsync().catch(() => {});
        setChecking(false);
        setFound({ qr: scan.qr, look });
    };

    // Opened as a link: read it straight away, no camera — once the account has loaded (a cold start opens the link first).
    useEffect(() => {
        if (fromLink && !isLoading) void read(fromLink);
    }, [fromLink, isLoading]);

    const onScanned = ({ data }: BarcodeScanningResult) => { void read(data); };

    const handle = (out: UnlockOutcome) => {
        switch (out.kind) {
            case 'unlocked':
                setDone(out.purpose);
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
                return;
            case 'no-device-lock':
                Alert.alert('Set a screen lock first', NO_DEVICE_LOCK_MESSAGE);
                return;
            case 'unlock-failed':
                return; // They cancelled, or the phone said no. The sheet stays for another try.
            case 'refused':
            case 'error':
                Alert.alert("Couldn't unlock", out.message, [{ text: 'OK', onPress: fromLink ? () => router.back() : resumeScanning }]);
                return;
        }
    };

    const approve = async () => {
        if (!found || !identity || busy) return;
        setBusy(true);
        try {
            handle(await approveUnlock({ qr: found.qr, check: found.look.check, identity, communityName }));
        } finally {
            setBusy(false);
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

    const sheet = (
        <Modal visible={!!found} transparent animationType="slide" onRequestClose={busy ? () => {} : () => (fromLink ? router.back() : resumeScanning())}>
            <View style={styles.sheetBackdrop}>
                <ScrollView
                    style={[styles.sheet, { backgroundColor: colors.surface.card, borderColor: colors.border.default }]}
                    contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 20 }}
                >
                    {done && found ? (
                        <View style={{ alignItems: 'center' }} accessibilityLiveRegion="polite">
                            <Text style={{ fontSize: 40, marginBottom: 8 }} accessibilityElementsHidden>✅</Text>
                            <Text style={[styles.title, { color: colors.text.heading }]}>Unlocked</Text>
                            <Text style={[styles.body, { color: colors.text.secondary }]}>
                                {done === 'takeover'
                                    ? `Now finish on ${found.look.host}'s screen: it shows what will happen, then “Take over now”.`
                                    : `${found.look.host} is restoring the backup and will restart by itself.`}
                            </Text>
                            <Pressable style={[styles.primaryBtn, { backgroundColor: colors.brand.primary }]} onPress={() => router.back()} accessibilityRole="button">
                                <Text style={[styles.primaryText, { color: colors.text.inverse }]}>Done</Text>
                            </Pressable>
                        </View>
                    ) : found ? (
                        <UnlockDetails found={found} communityName={communityName} callsign={identity?.callsign} busy={busy} fromLink={!!fromLink}
                            onApprove={approve} onCancel={() => (fromLink ? router.back() : resumeScanning())} />
                    ) : null}
                </ScrollView>
            </View>
        </Modal>
    );

    if (fromLink) {
        return (
            <View style={[styles.center, { backgroundColor: colors.surface.app, paddingTop: insets.top + 56 }]}>
                {close}
                {checking && <ActivityIndicator size="large" color={palette.emerald500} />}
                {sheet}
            </View>
        );
    }

    if (!permission) {
        return <View style={[styles.center, { backgroundColor: '#000' }]}><ActivityIndicator size="large" color={palette.emerald500} /></View>;
    }

    if (!permission.granted) {
        return (
            <View style={[styles.center, { backgroundColor: colors.surface.app, paddingTop: insets.top + 56 }]}>
                {close}
                <Text style={[styles.title, { color: colors.text.heading }]}>📷 Camera needed</Text>
                <Text style={[styles.body, { color: colors.text.secondary }]}>
                    To take over or restore with this phone, BeanPool scans the code on the server's Settings page.
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
                            On the standby's Settings choose “Take over with an owner's phone”, or restore a backup with a phone. Then point the camera at the code.
                        </Text>
                    )}
            </View>
            {sheet}
        </View>
    );
}

function UnlockDetails({ found, communityName, callsign, busy, fromLink, onApprove, onCancel }: {
    found: Found; communityName: string; callsign?: string; busy: boolean; fromLink: boolean; onApprove: () => void; onCancel: () => void;
}) {
    const { colors } = useTheme();
    const { look } = found;
    const takeover = look.described.purpose === 'takeover';
    const community = look.sameCommunity ? communityName : `community ${look.check.header.communityId.slice(0, 8)}`;
    const mainAnswers = look.described.takeover?.mainServerAnswers === true;
    const otherSigner = look.check.signer === 'other' || look.described.restore?.databaseOnly === true;
    return (
        <>
            <Text style={[styles.title, { color: colors.text.heading }]} accessibilityRole="header">
                {takeover ? `Take over ${community} on ${look.host}?` : `Restore ${community} on ${look.host}?`}
            </Text>
            <Text style={[styles.body, { color: colors.text.secondary }]}>
                {takeover
                    ? 'Do this only if your main server is really down. That server then becomes your community\'s main server, with the same identity, owners and web address.'
                    : `That server restores the backup locked ${day(look.described.restore?.backup?.createdAt ?? look.check.header.createdAt)} and becomes your community's server.`}
            </Text>
            {fromLink && (
                <View style={[styles.warnBox, { borderColor: colors.feedback.danger.solid }]} accessibilityRole="alert">
                    <Text style={[styles.infoLine, { color: colors.feedback.danger.solid, fontWeight: '700' }]}>
                        {openedFromLinkWarning(takeover ? 'takeover' : 'restore', look.host)}
                    </Text>
                </View>
            )}
            {takeover && mainAnswers && (
                <View style={[styles.warnBox, { borderColor: colors.feedback.danger.solid }]} accessibilityRole="alert">
                    <Text style={[styles.infoLine, { color: colors.feedback.danger.solid, fontWeight: '700' }]}>
                        Your main server still answers. Two servers with one identity will compete. Take over only if it is really gone, and never start it again.
                    </Text>
                </View>
            )}
            {otherSigner && (
                <View style={[styles.warnBox, { borderColor: colors.feedback.danger.solid }]} accessibilityRole="alert">
                    <Text style={[styles.infoLine, { color: colors.text.body }]}>
                        This backup was locked by another machine, not your community's server. Only its database comes back, never keys or passwords from inside it.
                    </Text>
                </View>
            )}
            <View style={[styles.infoBox, { borderColor: colors.border.default }]}>
                <Text style={[styles.infoLine, { color: colors.text.body }]}>Community: {community}</Text>
                <Text style={[styles.infoLine, { color: colors.text.body }]}>Server: {look.host}</Text>
                <Text style={[styles.infoLine, { color: colors.text.body }]}>Keys locked: {day(look.check.header.createdAt)}</Text>
                <Text style={[styles.infoLine, { color: colors.text.body }]}>As: {callsign || 'you'}</Text>
            </View>
            <Text style={[styles.small, { color: colors.text.secondary }]}>
                Your phone opens its own key to the locked keys and hands it to that server, locked so only that server can read it. Your phone never sees what is inside.
            </Text>
            <Pressable
                style={[styles.primaryBtn, { backgroundColor: colors.brand.primary }, busy && { opacity: 0.7 }]}
                onPress={onApprove}
                disabled={busy}
                accessibilityRole="button"
                accessibilityHint="Asks for your phone's unlock, then opens the keys for that server"
                accessibilityState={{ busy, disabled: busy }}
            >
                {busy
                    ? <ActivityIndicator color={colors.text.inverse} />
                    : <Text style={[styles.primaryText, { color: colors.text.inverse }]}>{takeover ? 'Unlock for the take-over' : 'Unlock the backup'}</Text>}
            </Pressable>
            <Pressable style={styles.secondaryBtn} onPress={onCancel} disabled={busy} accessibilityRole="button">
                <Text style={[styles.secondaryText, { color: colors.text.secondary }]}>Not now</Text>
            </Pressable>
        </>
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
    small: { fontSize: 13, lineHeight: 18, textAlign: 'center', marginBottom: 8 },
    infoBox: { borderWidth: 1, borderRadius: 12, padding: 12, marginVertical: 12, gap: 4 },
    warnBox: { borderWidth: 2, borderRadius: 12, padding: 12, marginVertical: 6 },
    infoLine: { fontSize: 14, lineHeight: 20 },
    primaryBtn: { minHeight: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20, marginTop: 8, alignSelf: 'stretch' },
    primaryText: { fontSize: 16, fontWeight: '800', textAlign: 'center' },
    secondaryBtn: { minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, marginTop: 4 },
    secondaryText: { fontSize: 15, fontWeight: '700', textAlign: 'center' },
});
