/**
 * Pair Device Screen — QR-based Device Linking (#89).
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
    Alert,
    SafeAreaView,
    Platform,
    Modal,
} from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useIdentity } from './IdentityContext';
import { useTheme, useStyles } from './ThemeContext';
import { palette } from '../constants/colors';
import { encryptPairingPayload } from '@beanpool/core';
import { getMnemonic } from '../utils/identity';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface ParsedPairingData {
    sessionId: string;
    desktopPubHex: string;
    nodeUrl: string;
}

export default function PairDeviceScreen() {
    const { theme, colors } = useTheme();
    const { identity } = useIdentity();
    const [permission, requestPermission] = useCameraPermissions();

    const [scannedData, setScannedData] = useState<ParsedPairingData | null>(null);
    const [isTransferring, setIsTransferring] = useState(false);
    const [transferSuccess, setTransferSuccess] = useState(false);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const isScanningLocked = useRef(false);

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
                backgroundColor: palette.emerald600,
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
                backgroundColor: palette.emerald600,
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

    function parsePairingUri(raw: string): ParsedPairingData | null {
        try {
            // Supports beanpool://pair?session=...&pub=...&node=...
            // or https://.../?pair=...
            let session = '';
            let pub = '';
            let node = '';

            if (raw.startsWith('beanpool://pair') || raw.startsWith('beanpool://')) {
                const url = new URL(raw.replace('beanpool://pair', 'https://placeholder.invalid'));
                session = url.searchParams.get('session') || '';
                pub = url.searchParams.get('pub') || '';
                node = url.searchParams.get('node') || '';
            } else if (raw.includes('session=') && raw.includes('pub=')) {
                const url = new URL(raw);
                session = url.searchParams.get('session') || '';
                pub = url.searchParams.get('pub') || '';
                node = url.searchParams.get('node') || url.origin;
            }

            if (session && pub && /^[0-9a-fA-F]{16,64}$/.test(session) && /^[0-9a-fA-F]{64}$/.test(pub)) {
                return {
                    sessionId: session,
                    desktopPubHex: pub,
                    nodeUrl: node || '',
                };
            }
        } catch (e) {
            console.warn('[Pairing] Malformed QR barcode:', raw, e);
        }
        return null;
    }

    async function handleBarcodeScanned(result: BarcodeScanningResult) {
        if (isScanningLocked.current || isTransferring || scannedData) return;
        const parsed = parsePairingUri(result.data);
        if (parsed) {
            isScanningLocked.current = true;
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            setScannedData(parsed);
        }
    }

    async function handleConfirmLink() {
        if (!scannedData || !identity) return;

        setIsTransferring(true);
        setErrorMessage(null);

        try {
            // Determine target node URL
            let targetNode = scannedData.nodeUrl;
            if (!targetNode) {
                const anchor = await AsyncStorage.getItem('beanpool_anchor_url');
                targetNode = anchor || '';
            }

            if (!targetNode) {
                throw new Error('Unable to determine target node address');
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
                scannedData.desktopPubHex,
                scannedData.sessionId
            );

            // POST to target node relay
            const res = await fetch(`${targetNode}/api/pair/transfer`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    sessionId: scannedData.sessionId,
                    mobilePubHex: encrypted.mobilePubHex,
                    nonceHex: encrypted.nonceHex,
                    ciphertextHex: encrypted.ciphertextHex,
                }),
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.error || `Transfer failed with status ${res.status}`);
            }

            setTransferSuccess(true);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

            setTimeout(() => {
                router.back();
            }, 1200);
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
        setScannedData(null);
        setErrorMessage(null);
        setTransferSuccess(false);
        setTimeout(() => {
            isScanningLocked.current = false;
        }, 500);
    }

    if (!permission) {
        return (
            <SafeAreaView style={styles.permissionCard}>
                <ActivityIndicator size="large" color={palette.emerald500} />
            </SafeAreaView>
        );
    }

    if (!permission.granted) {
        return (
            <SafeAreaView style={styles.permissionCard}>
                <Text style={styles.permissionTitle}>📷 Camera Permission Needed</Text>
                <Text style={styles.permissionDesc}>
                    BeanPool requires camera access to scan the pairing QR code displayed on your computer.
                </Text>
                <Pressable style={styles.permissionBtn} onPress={requestPermission} accessibilityRole="button">
                    <Text style={styles.permissionBtnText}>Enable Camera Access</Text>
                </Pressable>
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
                <Text style={styles.headerTitle}>Link Another Device</Text>
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
                        {transferSuccess ? (
                            <View style={{ alignItems: 'center', paddingVertical: 20 }}>
                                <Text style={{ fontSize: 48, marginBottom: 12 }}>✨</Text>
                                <Text style={styles.sheetTitle}>Device Linked!</Text>
                                <Text style={styles.sheetSubtitle}>
                                    Your computer is now signed in as {identity?.callsign}.
                                </Text>
                            </View>
                        ) : (
                            <>
                                <Text style={styles.sheetTitle}>Authorize Device Linking?</Text>
                                <Text style={styles.sheetSubtitle}>
                                    This will securely copy your sovereign identity to your web browser session.
                                </Text>

                                <View style={styles.infoBox}>
                                    <View style={styles.infoRow}>
                                        <Text style={styles.infoLabel}>Account</Text>
                                        <Text style={styles.infoValue}>{identity?.callsign}</Text>
                                    </View>
                                    <View style={[styles.infoRow, { marginBottom: 0 }]}>
                                        <Text style={styles.infoLabel}>Public Key</Text>
                                        <Text style={styles.infoValue}>
                                            {identity?.publicKey ? `${identity.publicKey.slice(0, 10)}...${identity.publicKey.slice(-6)}` : 'Unknown'}
                                        </Text>
                                    </View>
                                </View>

                                {errorMessage && (
                                    <Text style={{ color: palette.red500, fontSize: 13, textAlign: 'center', marginBottom: 16 }}>
                                        {errorMessage}
                                    </Text>
                                )}

                                <Pressable
                                    style={[styles.confirmBtn, isTransferring && { opacity: 0.7 }]}
                                    onPress={handleConfirmLink}
                                    disabled={isTransferring}
                                    accessibilityRole="button"
                                >
                                    {isTransferring ? (
                                        <ActivityIndicator color="#ffffff" />
                                    ) : (
                                        <Text style={styles.confirmBtnText}>Confirm & Link Device</Text>
                                    )}
                                </Pressable>

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
