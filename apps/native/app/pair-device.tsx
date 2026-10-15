/**
 * Pair Device Screen — QR-based Device Linking (#89). Settings → "Use your account on another device" (older apps:
 * "Link Another Device"): the member's own account goes to that browser, unlike "Manage this community from a computer".
 *
 * Scans an ephemeral QR code displayed on a desktop PWA or another client,
 * derives an E2E shared secret via X25519 ECDH + HKDF, encrypts the sovereign identity,
 * and transfers it via the local node's in-memory pairing relay.
 */

import React, { useState, useEffect, useRef } from 'react';
import {
    View,
    Text,
    StyleSheet,
    Pressable,
    ActivityIndicator,
    SafeAreaView,
    Platform,
    Modal,
    Linking,
    Alert,
} from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { router, ErrorBoundary } from 'expo-router';
import { claimRouteFor, parseClaimLink } from '../utils/claim-link';
import * as Haptics from 'expo-haptics';

export { ErrorBoundary };
import { useIdentity } from './IdentityContext';
import { useTheme, useStyles } from './ThemeContext';
import { palette } from '../constants/colors';
import { encryptPairingPayload, t } from '@beanpool/core';
import { getMnemonic } from '../utils/identity';
import { requireDeviceUnlock } from '../utils/node-admin';
import { shouldBlockCleartextNodeUrl } from '../utils/node-url';
import { isUnreadablePairingQr, pairingRequestUrls, parsePairingQr, transferTarget, type PairingQr, type TransferTarget } from '../utils/pair-device-target';
import { getSavedNodes } from '../utils/nodes';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface ParsedPairingData extends PairingQr {
    /** Where the account may go: only a server this phone already uses (utils/pair-device-target.ts). Set at scan. */
    target?: TransferTarget;
}

export default function PairDeviceScreen() {
    const { theme, colors } = useTheme();
    const { identity } = useIdentity();
    const [permission, requestPermission] = useCameraPermissions();

    const [scannedData, setScannedData] = useState<ParsedPairingData | null>(null);
    const [isTransferring, setIsTransferring] = useState(false);
    /** The two digits the relay gave back: the other device types them before it gets anything. */
    const [confirmCode, setConfirmCode] = useState<string | null>(null);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const isScanningLocked = useRef(false);
    const scannedDataRef = useRef(scannedData);
    scannedDataRef.current = scannedData;
    const lockBusyRef = useRef(false);
    const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        return () => {
            if (navTimerRef.current) {
                clearTimeout(navTimerRef.current);
            }
        };
    }, []);

    const styles = useStyles(({ theme, colors }) =>
        StyleSheet.create({
            container: {
                flex: 1,
                backgroundColor: '#000000',
            },
            header: {
                position: 'absolute',
                top: Platform.OS === 'ios' ? 50 : 20,
                left: 16,
                right: 16,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                zIndex: 10,
            },
            closeBtn: {
                width: 40,
                height: 40,
                borderRadius: 20,
                backgroundColor: 'rgba(0,0,0,0.6)',
                alignItems: 'center',
                justifyContent: 'center',
            },
            closeBtnText: {
                color: '#ffffff',
                fontSize: 20,
                fontWeight: '700',
            },
            headerTitle: {
                // Between the ✕ and its spacer: at 320dp with large text it wraps instead of pushing past the screen edge.
                flexShrink: 1,
                marginHorizontal: 8,
                textAlign: 'center',
                color: '#ffffff',
                fontSize: 17,
                fontWeight: '700',
            },
            viewfinderWrap: {
                flex: 1,
                alignItems: 'center',
                justifyContent: 'center',
            },
            overlay: {
                ...StyleSheet.absoluteFillObject,
                alignItems: 'center',
                justifyContent: 'center',
            },
            reticle: {
                width: 250,
                height: 250,
                borderRadius: 24,
                borderWidth: 2.5,
                borderColor: palette.emerald400,
                backgroundColor: 'transparent',
                position: 'relative',
            },
            cornerTL: {
                position: 'absolute',
                top: -3,
                left: -3,
                width: 32,
                height: 32,
                borderTopWidth: 5,
                borderLeftWidth: 5,
                borderColor: palette.emerald400,
                borderTopLeftRadius: 24,
            },
            cornerTR: {
                position: 'absolute',
                top: -3,
                right: -3,
                width: 32,
                height: 32,
                borderTopWidth: 5,
                borderRightWidth: 5,
                borderColor: palette.emerald400,
                borderTopRightRadius: 24,
            },
            cornerBL: {
                position: 'absolute',
                bottom: -3,
                left: -3,
                width: 32,
                height: 32,
                borderBottomWidth: 5,
                borderLeftWidth: 5,
                borderColor: palette.emerald400,
                borderBottomLeftRadius: 24,
            },
            cornerBR: {
                position: 'absolute',
                bottom: -3,
                right: -3,
                width: 32,
                height: 32,
                borderBottomWidth: 5,
                borderRightWidth: 5,
                borderColor: palette.emerald400,
                borderBottomRightRadius: 24,
            },
            instructionCard: {
                position: 'absolute',
                bottom: Platform.OS === 'ios' ? 60 : 40,
                left: 20,
                right: 20,
                backgroundColor: 'rgba(24, 24, 27, 0.85)',
                borderRadius: 16,
                padding: 16,
                alignItems: 'center',
                borderWidth: 1,
                borderColor: 'rgba(255,255,255,0.15)',
            },
            instructionText: {
                color: '#ffffff',
                fontSize: 14,
                fontWeight: '600',
                textAlign: 'center',
                lineHeight: 20,
            },
            permissionCard: {
                flex: 1,
                backgroundColor: theme === 'dark' ? colors.surface.app : palette.grayAlt100,
                alignItems: 'center',
                justifyContent: 'center',
                padding: 24,
            },
            permissionTitle: {
                fontSize: 20,
                fontWeight: '800',
                color: colors.text.heading,
                marginBottom: 10,
                textAlign: 'center',
            },
            permissionDesc: {
                fontSize: 14,
                color: colors.text.secondary,
                textAlign: 'center',
                lineHeight: 21,
                marginBottom: 24,
            },
            permissionBtn: {
                backgroundColor: colors.brand.fill,
                paddingHorizontal: 24,
                paddingVertical: 14,
                borderRadius: 14,
            },
            permissionBtnText: {
                color: '#ffffff',
                fontWeight: '700',
                fontSize: 15,
            },
            modalOverlay: {
                flex: 1,
                backgroundColor: 'rgba(0,0,0,0.65)',
                justifyContent: 'flex-end',
            },
            sheet: {
                backgroundColor: theme === 'dark' ? '#18181b' : '#ffffff',
                borderTopLeftRadius: 24,
                borderTopRightRadius: 24,
                padding: 24,
                paddingBottom: Platform.OS === 'ios' ? 44 : 24,
            },
            sheetTitle: {
                fontSize: 19,
                fontWeight: '800',
                color: colors.text.heading,
                marginBottom: 8,
                textAlign: 'center',
            },
            sheetSubtitle: {
                fontSize: 14,
                color: colors.text.secondary,
                textAlign: 'center',
                lineHeight: 20,
                marginBottom: 20,
            },
            infoBox: {
                backgroundColor: theme === 'dark' ? '#27272a' : palette.grayAlt100,
                borderRadius: 14,
                padding: 14,
                marginBottom: 20,
            },
            infoRow: {
                flexDirection: 'row',
                justifyContent: 'space-between',
                marginBottom: 8,
            },
            infoLabel: {
                fontSize: 13,
                color: colors.text.secondary,
                fontWeight: '600',
            },
            infoValue: {
                fontSize: 13,
                color: colors.text.heading,
                fontWeight: '700',
            },
            confirmBtn: {
                backgroundColor: colors.brand.fill,
                borderRadius: 14,
                paddingVertical: 15,
                alignItems: 'center',
                marginBottom: 10,
            },
            confirmBtnText: {
                color: '#ffffff',
                fontSize: 16,
                fontWeight: '700',
            },
            cancelBtn: {
                paddingVertical: 12,
                alignItems: 'center',
            },
            cancelBtnText: {
                color: colors.text.secondary,
                fontSize: 15,
                fontWeight: '600',
            },
        })
    );

    async function handleBarcodeScanned(result: BarcodeScanningResult) {
        if (isScanningLocked.current || isTransferring || scannedData) return;
        // A server's claim QR (`beanpool claim`): the claim screen, which offers the claim only while that server has no owner.
        const claim = parseClaimLink(result.data);
        if (claim) {
            isScanningLocked.current = true;
            router.replace(claimRouteFor(claim) as any);
            return;
        }
        // Read by a strict grammar (utils/pair-device-target.ts): any other spelling is refused here, nothing sent.
        const parsed = parsePairingQr(result.data);
        if (!parsed) {
            // A pairing code it refuses is said so, in one sentence, and the camera waits for OK. Any other QR: ignored.
            if (isUnreadablePairingQr(result.data)) {
                isScanningLocked.current = true;
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
                Alert.alert('', t('This code can\'t be read safely, so nothing was sent: make a new code on the other device and scan that one.'), [{ text: t('OK'), onPress: resumeScanning }], { cancelable: false });
            }
            return;
        }
        isScanningLocked.current = true;
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        // The key and the 12 words go only to a server this phone already uses: a QR naming any other could come from
        // a server that skips the digits. Said at once, and nothing is sent.
        const anchor = await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null);
        const saved = (await getSavedNodes().catch(() => [])).map((n) => n.url);
        const target = transferTarget(parsed.nodeUrl, anchor, saved);
        setErrorMessage(target.kind === 'ok' ? null : targetRefusal(target));
        setScannedData({ ...parsed, target });
    }

    /** After the refusal's OK: a moment first, so the same code still in view isn't read again at once. */
    function resumeScanning() {
        setTimeout(() => {
            isScanningLocked.current = false;
        }, 600);
    }

    function targetRefusal(target: Exclude<TransferTarget, { kind: 'ok' }>): string {
        if (target.kind === 'no-node') return t('Connect to your community first.');
        return target.appHost
            ? t('This code is from {host}, a server your phone doesn\'t use: it uses {own}. Nothing was sent. Scan the code {own} shows on the other device, or restore your account there with your 12 words.', { host: target.scannedHost, own: target.appHost })
            : t('This code is from {host}, a server your phone doesn\'t use. Nothing was sent. To use your account there, restore it with your 12 words.', { host: target.scannedHost });
    }

    async function handleConfirmLink() {
        if (!scannedData || !identity || isTransferring || lockBusyRef.current) return;
        const scanned = scannedData;
        const target = scanned.target;
        // Only to a server this phone already uses (handleBarcodeScanned): anything else asks nothing and sends nothing.
        if (!target || target.kind !== 'ok') {
            setErrorMessage(target ? targetRefusal(target) : t('Connect to your community first.'));
            return;
        }

        // The whole account goes to the other device, key and 12 words: the phone's own unlock first, failing closed as
        // Manage and the Settings QR do (requireDeviceUnlock). A phone with no screen lock sends nothing: the account would
        // leave with nobody asked. A check that doesn't pass reads and sends nothing, and the sheet stays as it was.
        lockBusyRef.current = true;
        const unlock = await requireDeviceUnlock('', t('Confirm it is you to send your account to another device.'));
        lockBusyRef.current = false;
        if (unlock === 'no-device-lock' && scannedDataRef.current === scanned) {
            setErrorMessage(t('Your phone has no screen lock, so BeanPool will not send your account. Set a PIN, pattern or password in your phone\'s Settings, under Security, then try again.'));
            return;
        }
        if (unlock === 'failed' && scannedDataRef.current === scanned) setErrorMessage(t('The phone\'s unlock did not pass, so nothing was sent.'));
        // Not passed, or the sheet was closed (or another code scanned) while it asked: nothing is sent.
        if (unlock !== 'ok' || scannedDataRef.current !== scanned) return;

        setIsTransferring(true);
        setErrorMessage(null);

        try {
            // The phone's own saved address for the server the QR names (transferTarget), in its canonical origin: never
            // the QR's text. Every request below is built from it (pairingRequestUrls).
            const targetNode = target.nodeUrl;

            if (shouldBlockCleartextNodeUrl(targetNode)) {
                throw new Error('Insecure pairing relay URL. HTTPS required for public host.');
            }
            const urls = pairingRequestUrls(target, scanned.sessionId);

            // Before the words are read: a relay that can't hold the account for the digits answers a poll from a phone
            // (no binding cookie) with the session itself; one that can answers wrong-browser. Ask first, so an older
            // server is told so with nothing sent.
            const probe = await fetch(urls.probe, { headers: { Accept: 'application/json' } });
            const probeBody = await probe.json().catch(() => ({}));
            if (probe.status === 200 && probeBody.status === 'waiting') {
                throw new Error(t('Your community\'s server runs an older BeanPool that can\'t ask for the two digits, so nothing was sent. Ask its host to update it.'));
            }
            if (probe.status === 200 && probeBody.status === 'expired') {
                throw new Error(t('That code has expired, so nothing was sent. Make a new code on the other device and scan it again.'));
            }

            // Retrieve full mnemonic recovery words if available
            const mnemonic = await getMnemonic(identity);

            const payloadToEncrypt = {
                callsign: identity.callsign,
                publicKey: identity.publicKey,
                privateKey: identity.privateKey,
                mnemonic: mnemonic || undefined,
                createdAt: identity.createdAt,
                version: 1,
            };

            const encrypted = encryptPairingPayload(
                payloadToEncrypt,
                scanned.desktopPubHex,
                scanned.sessionId
            );

            // POST to target node relay
            const res = await fetch(urls.transfer, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    sessionId: scanned.sessionId,
                    mobilePubHex: encrypted.mobilePubHex,
                    nonceHex: encrypted.nonceHex,
                    ciphertextHex: encrypted.ciphertextHex,
                }),
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.error || `Transfer failed with status ${res.status}`);
            }

            // The relay holds the account until the other device types these two digits (number matching): someone who
            // only sent a QR never sees this screen. A relay that gives none is too old to hold it: say so.
            const done = await res.json().catch(() => ({}));
            const code = typeof done.confirmCode === 'string' && /^\d{2}$/.test(done.confirmCode) ? done.confirmCode : null;
            if (!code) throw new Error(t('Your community\'s server did not ask for the two digits. Ask its host to update BeanPool before you try again.'));
            setConfirmCode(code);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } catch (err: any) {
            console.error('[Pairing] Transfer error:', err);
            setErrorMessage(err.message || 'Failed to link device');
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        } finally {
            setIsTransferring(false);
        }
    }

    function handleDismissSheet() {
        if (isTransferring) return;
        // Closed while the relay holds the account for the digits: it drops it, so the other device gets nothing.
        const target = scannedData?.target;
        if (confirmCode && scannedData && target?.kind === 'ok') {
            fetch(pairingRequestUrls(target, scannedData.sessionId).cancel, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: scannedData.sessionId }),
            }).catch(() => {});
        }
        setScannedData(null);
        setErrorMessage(null);
        setConfirmCode(null);
        setTimeout(() => {
            isScanningLocked.current = false;
        }, 500);
    }

    if (!permission) {
        return (
            <SafeAreaView style={styles.permissionCard}>
                <ActivityIndicator size="large" color={colors.brand.primary} />
            </SafeAreaView>
        );
    }

    if (!permission.granted) {
        return (
            <SafeAreaView style={styles.permissionCard}>
                <Pressable
                    style={[styles.closeBtn, { position: 'absolute', top: Platform.OS === 'ios' ? 50 : 20, left: 20 }]}
                    onPress={() => router.back()}
                    accessibilityRole="button"
                    accessibilityLabel="Go back"
                >
                    <Text style={styles.closeBtnText}>✕</Text>
                </Pressable>
                <Text style={styles.permissionTitle}>📷 Camera Permission Needed</Text>
                <Text style={styles.permissionDesc}>
                    BeanPool requires camera access to scan the pairing QR code displayed on your computer.
                </Text>
                {permission.canAskAgain ? (
                    <Pressable style={styles.permissionBtn} onPress={requestPermission} accessibilityRole="button">
                        <Text style={styles.permissionBtnText}>Enable Camera Access</Text>
                    </Pressable>
                ) : (
                    <Pressable style={styles.permissionBtn} onPress={() => Linking.openSettings()} accessibilityRole="button">
                        <Text style={styles.permissionBtnText}>Open Device Settings</Text>
                    </Pressable>
                )}
            </SafeAreaView>
        );
    }

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Pressable
                    style={styles.closeBtn}
                    onPress={() => router.back()}
                    accessibilityRole="button"
                    accessibilityLabel="Close camera scanner"
                >
                    <Text style={styles.closeBtnText}>✕</Text>
                </Pressable>
                <Text style={styles.headerTitle}>Your account on another device</Text>
                <View style={{ width: 40 }} />
            </View>

            <CameraView
                style={StyleSheet.absoluteFillObject}
                barcodeScannerSettings={{
                    barcodeTypes: ['qr'],
                }}
                onBarcodeScanned={scannedData ? undefined : handleBarcodeScanned}
            />

            <View style={styles.overlay} pointerEvents="none">
                <View style={styles.reticle}>
                    <View style={styles.cornerTL} />
                    <View style={styles.cornerTR} />
                    <View style={styles.cornerBL} />
                    <View style={styles.cornerBR} />
                </View>
            </View>

            <View style={styles.instructionCard}>
                <Text style={styles.instructionText}>
                    Point your camera at the QR code on your computer's screen to link devices.
                </Text>
            </View>

            {/* Confirmation Modal Sheet */}
            <Modal
                visible={!!scannedData}
                transparent
                animationType="slide"
                onRequestClose={handleDismissSheet}
            >
                <View style={styles.modalOverlay}>
                    <View style={styles.sheet}>
                        {confirmCode ? (
                            <View style={{ alignItems: 'center', paddingVertical: 20 }}>
                                <Text style={styles.sheetTitle}>{t('Type these two digits on the other device')}</Text>
                                <Text
                                    style={[styles.sheetTitle, { fontSize: 40, letterSpacing: 8, marginVertical: 12 }]}
                                    accessibilityLabel={t('The two digits are {digits}', { digits: confirmCode.split('').join(' ') })}
                                >
                                    {confirmCode}
                                </Text>
                                <Text style={styles.sheetSubtitle}>
                                    {t('Your account opens there only after the right digits are typed. If you did not just ask for this on a screen in front of you, tap Cancel and the other device gets nothing.')}
                                </Text>
                                <Pressable style={styles.cancelBtn} onPress={() => router.back()} accessibilityRole="button">
                                    <Text style={styles.cancelBtnText}>{t('Done')}</Text>
                                </Pressable>
                                <Pressable style={styles.cancelBtn} onPress={handleDismissSheet} accessibilityRole="button">
                                    <Text style={styles.cancelBtnText}>{t('Cancel')}</Text>
                                </Pressable>
                            </View>
                        ) : (
                            <>
                                <Text style={styles.sheetTitle}>{t('Send your whole account to another device?')}</Text>
                                <Text style={styles.sheetSubtitle}>
                                    {t('The other device receives this account\'s key AND your 12 words: whoever has them is you, in every community.')}
                                </Text>
                                <Text style={[styles.sheetSubtitle, { fontWeight: '700' }]}>
                                    {t('Only scan a code on a screen in front of you that you just opened yourself. Never one someone sent you or put on a sign.')}
                                </Text>

                                <View style={styles.infoBox}>
                                    <View style={styles.infoRow}>
                                        <Text style={styles.infoLabel}>Account</Text>
                                        <Text style={styles.infoValue}>{identity?.callsign}</Text>
                                    </View>
                                    <View style={styles.infoRow}>
                                        <Text style={styles.infoLabel}>Target Host</Text>
                                        <Text style={styles.infoValue}>
                                            {scannedData?.target?.kind === 'ok' ? scannedData.target.nodeUrl.replace(/^https:\/\//, '') : scannedData?.target?.kind === 'foreign' ? scannedData.target.scannedHost : ''}
                                        </Text>
                                    </View>
                                    <View style={[styles.infoRow, { marginBottom: 0 }]}>
                                        <Text style={styles.infoLabel}>Public Key</Text>
                                        <Text style={styles.infoValue}>
                                            {identity?.publicKey ? `${identity.publicKey.slice(0, 10)}...${identity.publicKey.slice(-6)}` : 'Unknown'}
                                        </Text>
                                    </View>
                                </View>

                                {errorMessage && (
                                    <Text
                                        style={{ color: colors.feedback.danger.fg, fontSize: 13, textAlign: 'center', marginBottom: 16 }}
                                        accessibilityRole="alert"
                                    >
                                        {errorMessage}
                                    </Text>
                                )}

                                {scannedData?.target?.kind === 'ok' && (
                                <Pressable
                                    style={[styles.confirmBtn, isTransferring && { opacity: 0.7 }]}
                                    onPress={handleConfirmLink}
                                    disabled={isTransferring}
                                    accessibilityRole="button"
                                    accessibilityLabel={isTransferring ? 'Linking device, please wait...' : 'Confirm & Link Device'}
                                    accessibilityState={{ busy: isTransferring, disabled: isTransferring }}
                                >
                                    {isTransferring ? (
                                        <ActivityIndicator color="#ffffff" />
                                    ) : (
                                        <Text style={styles.confirmBtnText}>Confirm & Link Device</Text>
                                    )}
                                </Pressable>
                                )}

                                <Pressable
                                    style={styles.cancelBtn}
                                    onPress={handleDismissSheet}
                                    disabled={isTransferring}
                                    accessibilityRole="button"
                                >
                                    <Text style={styles.cancelBtnText}>Cancel</Text>
                                </Pressable>
                            </>
                        )}
                    </View>
                </View>
            </Modal>
        </View>
    );
}
